// flutterwave-service.js
// The ONLY module that talks to Flutterwave for virtual account creation.
// No route, controller, or worker should call the Flutterwave API directly —
// they all go through the functions exported here.

const FLW_BASE_URL = "https://api.flutterwave.com/v3";

function getSecretKey() {
  const key = process.env.FLUTTERWAVE_SECRET_KEY;
  if (!key) {
    throw new Error("FLUTTERWAVE_SECRET_KEY is not set");
  }
  return key;
}

/**
 * Creates a permanent dedicated virtual account for a user.
 * Requires a BVN — Flutterwave rejects permanent account creation without one.
 *
 * @param {Object} params
 * @param {string} params.email
 * @param {string} params.bvn - 11-digit BVN
 * @param {string} params.firstname
 * @param {string} params.lastname
 * @param {string} params.phonenumber
 * @param {string} params.txRef - unique reference for this creation attempt,
 *   used for idempotency on Flutterwave's side (safe to retry with the same
 *   txRef; Flutterwave will not create a duplicate for the same reference).
 * @returns {Promise<{success: boolean, data?: object, error?: string, raw?: object}>}
 */
async function createVirtualAccount({
  email,
  bvn,
  firstname,
  lastname,
  phonenumber,
  txRef,
}) {
  if (!bvn || !/^\d{11}$/.test(bvn)) {
    return { success: false, error: "Invalid or missing BVN" };
  }

  const body = {
    email,
    is_permanent: true,
    bvn,
    tx_ref: txRef,
    phonenumber,
    firstname,
    lastname,
    narration: `Feecent - ${firstname} ${lastname}`,
  };

  let response;
  try {
    response = await fetch(`${FLW_BASE_URL}/virtual-account-numbers`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getSecretKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (networkErr) {
    // Network-level failure (timeout, DNS, Flutterwave fully down) —
    // treat as retryable, never let this bubble up and block a caller.
    return {
      success: false,
      error: `Network error contacting Flutterwave: ${networkErr.message}`,
    };
  }

  let json;
  try {
    json = await response.json();
  } catch (parseErr) {
    return {
      success: false,
      error: `Invalid JSON from Flutterwave (HTTP ${response.status})`,
    };
  }

  if (!response.ok || json.status !== "success") {
    return {
      success: false,
      error: json.message || `Flutterwave error (HTTP ${response.status})`,
      raw: json,
    };
  }

  const d = json.data;
  return {
    success: true,
    data: {
      provider_account_id: String(d.order_ref || d.id || ""),
      account_number: d.account_number,
      bank_name: d.bank_name,
      // Flutterwave's virtual-account-numbers response doesn't return a
      // separate numeric bank_code on this endpoint — bank_name is the
      // identifying field. Leave bank_code null unless you resolve it
      // separately against the /v3/banks list.
      bank_code: null,
    },
    raw: json,
  };
}

/**
 * Initiates a payout (external transfer) via Flutterwave's Transfers API.
 * This is the ONLY place in the codebase that should call POST /transfers.
 */
async function initiateTransfer({
  accountBank,
  accountNumber,
  amount,
  narration,
  reference,
  beneficiaryName,
}) {
  let response;
  try {
    response = await fetch(`${FLW_BASE_URL}/transfers`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getSecretKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        account_bank: accountBank,
        account_number: accountNumber,
        amount,
        narration: narration || `Transfer to ${beneficiaryName}`,
        currency: "NGN",
        reference,
        callback_url: process.env.FLUTTERWAVE_TRANSFER_WEBHOOK_URL,
        beneficiary_name: beneficiaryName,
        debit_currency: "NGN",
      }),
    });
  } catch (networkErr) {
    return {
      success: false,
      error: `Network error contacting Flutterwave transfers API: ${networkErr.message}`,
      retryable: true,
    };
  }

  let json;
  try {
    json = await response.json();
  } catch (parseErr) {
    return {
      success: false,
      error: `Invalid JSON from Flutterwave transfers API (HTTP ${response.status})`,
      retryable: true,
    };
  }

  if (!response.ok || json.status !== "success") {
    return {
      success: false,
      error:
        json.message || `Flutterwave transfer error (HTTP ${response.status})`,
      retryable: response.status >= 500,
      raw: json,
    };
  }

  const d = json.data;
  return {
    success: true,
    data: {
      flw_id: d.id,
      status: d.status,
      reference: d.reference,
    },
    raw: json,
  };
}

/**
 * Checks the current status of a previously-initiated transfer directly
 * with Flutterwave. Used by the retry worker and the outbound webhook
 * handler to confirm status before crediting/debiting anything.
 */
async function getTransferStatus(flwTransferId) {
  let response;
  try {
    response = await fetch(`${FLW_BASE_URL}/transfers/${flwTransferId}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${getSecretKey()}` },
    });
  } catch (networkErr) {
    return {
      success: false,
      error: `Network error checking transfer status: ${networkErr.message}`,
    };
  }

  let json;
  try {
    json = await response.json();
  } catch (parseErr) {
    return {
      success: false,
      error: `Invalid JSON checking transfer status (HTTP ${response.status})`,
    };
  }

  if (!response.ok || json.status !== "success") {
    return {
      success: false,
      error: json.message || `Status check failed (HTTP ${response.status})`,
    };
  }

  const d = json.data;
  return {
    success: true,
    data: {
      id: d.id,
      reference: d.reference,
      status: d.status,
      complete_message: d.complete_message,
      amount: d.amount,
      account_number: d.account_number,
      bank_code: d.bank_code,
    },
  };
}

/**
 * Verifies a Flutterwave webhook signature.
 * Flutterwave sends the secret hash you configured in the dashboard back
 * verbatim in the `verif-hash` header — no HMAC computation needed, just a
 * constant-time string comparison.
 */
function verifyWebhookSignature(headerHash) {
  const expected = process.env.FLUTTERWAVE_WEBHOOK_SECRET;
  if (!expected || !headerHash) return false;
  if (headerHash.length !== expected.length) return false;

  // Constant-time comparison to avoid timing attacks.
  const crypto = require("crypto");
  return crypto.timingSafeEqual(Buffer.from(headerHash), Buffer.from(expected));
}

/**
 * Verifies a transaction directly with Flutterwave's API. Webhook payloads
 * must never be trusted on their own — this confirms amount, currency,
 * status, and the destination account straight from Flutterwave before any
 * wallet is credited.
 *
 * @param {string|number} transactionId - Flutterwave's `data.id` from the webhook
 * @returns {Promise<{success: boolean, data?: object, error?: string}>}
 */
async function verifyTransaction(transactionId) {
  let response;
  try {
    response = await fetch(
      `${FLW_BASE_URL}/transactions/${transactionId}/verify`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${getSecretKey()}` },
      },
    );
  } catch (networkErr) {
    return {
      success: false,
      error: `Network error verifying transaction: ${networkErr.message}`,
    };
  }

  let json;
  try {
    json = await response.json();
  } catch (parseErr) {
    return {
      success: false,
      error: `Invalid JSON verifying transaction (HTTP ${response.status})`,
    };
  }

  if (!response.ok || json.status !== "success") {
    return {
      success: false,
      error: json.message || `Verify failed (HTTP ${response.status})`,
    };
  }

  const d = json.data;
  return {
    success: true,
    data: {
      id: d.id,
      tx_ref: d.tx_ref,
      flw_ref: d.flw_ref,
      amount: d.amount,
      currency: d.currency,
      status: d.status, // "successful", "failed", "pending"
      account_number:
        d.account_number || (d.meta && d.meta.originatoraccountnumber) || null,
      // For dedicated virtual account credits, Flutterwave includes the
      // receiving account's details under `data.account_id` /
      // `data.card`/`data.meta` depending on payment type — the safest
      // universal field for NUBAN transfers into a virtual account is
      // `data.customer.email` combined with `data.narration`, but the
      // account number match below is the authoritative check.
      narration: d.narration,
      customer_email: d.customer && d.customer.email,
      // Best-effort sender details for bank-transfer deposits — field
      // names vary by how the sending bank populates Flutterwave's meta;
      // confirm exact keys against a real sandbox payload.
      sender_name:
        (d.meta && (d.meta.originatorname || d.meta.originator_name)) || null,
      sender_account:
        (d.meta &&
          (d.meta.originatoraccountnumber ||
            d.meta.originator_account_number)) ||
        null,
      sender_bank:
        (d.meta && (d.meta.originatorbank || d.meta.originator_bank)) || null,
    },
  };
}

module.exports = {
  createVirtualAccount,
  verifyWebhookSignature,
  verifyTransaction,
  initiateTransfer,
  getTransferStatus,
};

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

module.exports = {
  createVirtualAccount,
  verifyWebhookSignature,
};
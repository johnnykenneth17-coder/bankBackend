// transfer-webhook-handler.js
// Handles the outbound side of Flutterwave webhooks: transfer.completed,
// transfer.failed, transfer.reversed. Called from deposit-webhook-service.js
// (which owns signature verification and webhook_id dedupe — the same
// /api/webhooks/flutterwave endpoint receives both deposit and payout
// events, since Flutterwave only supports one webhook URL per app).
//
// The webhook body is never trusted for the final money-movement
// decision. This module re-verifies the transfer directly against
// Flutterwave's API (flutterwaveService.getTransferStatus) and only
// then calls finalize_external_transfer(), which is the single place
// allowed to convert a reservation into a real debit or release it.

const { createClient } = require("@supabase/supabase-js");
const flutterwaveService = require("../flutterwave-service23");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

const WORKER_ID = `transfer-webhook-${process.env.VERCEL_REGION || "local"}-${process.pid}`;
const BACKOFF_MINUTES = [1, 5, 15, 30, 60];

async function processTransferEvent({ event, data, webhookLogId }) {
  if (!data || !data.id) {
    throw new Error("Transfer webhook payload missing data.id");
  }

  // Never trust the webhook body's status/amount — verify directly.
  const verification = await flutterwaveService.getTransferStatus(data.id);

  if (!verification.success) {
    // Flutterwave's API is unreachable/erroring right now. Queue a
    // background retry instead of guessing at the outcome.
    await enqueueRetry(data.id, webhookLogId, verification.error);
    if (webhookLogId) {
      await supabase
        .from("flutterwave_webhook_logs")
        .update({
          status: "verification_failed",
          error_message: verification.error,
        })
        .eq("id", webhookLogId);
    }
    return;
  }

  await finalizeFromVerifiedStatus(verification.data, webhookLogId);
}

async function finalizeFromVerifiedStatus(v, webhookLogId) {
  const { data: transfer, error: lookupErr } = await supabase
    .from("flutterwave_transfers")
    .select("id, status")
    .eq("transaction_reference", v.reference)
    .single();

  if (lookupErr || !transfer) {
    // No matching reservation — either a transfer we never initiated,
    // or the reference format changed. Flag for manual review rather
    // than silently dropping money-movement information.
    await supabase.from("reconciliation_alerts").insert({
      user_id: null,
      operational_balance: 0,
      ledger_balance: 0,
      difference: v.amount,
      status: "open",
      severity: "high",
      notes: `Transfer webhook verified (flw id ${v.id}, ref ${v.reference}, status ${v.status}) but no matching flutterwave_transfers row found.`,
    });
    if (webhookLogId) {
      await supabase
        .from("flutterwave_webhook_logs")
        .update({
          status: "no_matching_transfer",
          processed: true,
          processed_at: new Date().toISOString(),
        })
        .eq("id", webhookLogId);
    }
    return;
  }

  if (v.status === "SUCCESSFUL") {
    await supabase.rpc("finalize_external_transfer", {
      p_transfer_id: transfer.id,
      p_final_status: "completed",
      p_flutterwave_reference: String(v.id),
      p_flutterwave_status: v.status,
      p_failure_reason: null,
    });
  } else if (v.status === "FAILED") {
    await supabase.rpc("finalize_external_transfer", {
      p_transfer_id: transfer.id,
      p_final_status: "failed",
      p_flutterwave_reference: String(v.id),
      p_flutterwave_status: v.status,
      p_failure_reason: v.complete_message || "Transfer failed at Flutterwave",
    });
  } else {
    // NEW / PENDING — not a final state yet. Leave the reservation in
    // place; a later webhook delivery or the reconciliation sweep
    // (stuck_external_transfers) will resolve it.
    if (webhookLogId) {
      await supabase
        .from("flutterwave_webhook_logs")
        .update({
          status: "not_final",
          error_message: `Verified status was '${v.status}'`,
        })
        .eq("id", webhookLogId);
    }
    return;
  }

  if (webhookLogId) {
    await supabase
      .from("flutterwave_webhook_logs")
      .update({
        status: "completed",
        processed: true,
        processed_at: new Date().toISOString(),
      })
      .eq("id", webhookLogId);
  }
}

async function enqueueRetry(flwTransferId, webhookLogId, lastError) {
  await supabase.from("background_jobs").insert({
    job_type: "reconcile_transfer_webhook",
    payload: { flw_transfer_id: flwTransferId, webhook_log_id: webhookLogId },
    status: "pending",
    priority: 200,
    last_error: lastError || null,
  });
}

// ------------------------------------------------------------
// Reconciliation sweep: catches transfers stuck past the reservation
// window with no definitive webhook (spec item 14). Run on a cron
// alongside the deposit and virtual-account workers.
// ------------------------------------------------------------
async function reconcileStuckTransfers(limit = 20) {
  const { data: stuck, error } = await supabase
    .from("stuck_external_transfers")
    .select("id, transaction_reference")
    .limit(limit);

  if (error) {
    console.error(
      "[TRANSFER-RECONCILE] Failed to load stuck transfers:",
      error,
    );
    return 0;
  }

  let resolved = 0;
  for (const row of stuck || []) {
    const { data: transfer } = await supabase
      .from("flutterwave_transfers")
      .select("flutterwave_reference")
      .eq("id", row.id)
      .single();

    if (!transfer || !transfer.flutterwave_reference) {
      // Flutterwave never even acknowledged this one (processFlutterwaveTransfer
      // never got a response) — nothing to verify against yet, leave it
      // for the next sweep unless it's very old, in which case it should
      // be surfaced to an admin, not auto-failed.
      continue;
    }

    const verification = await flutterwaveService.getTransferStatus(
      transfer.flutterwave_reference,
    );
    if (!verification.success) continue;

    if (verification.data.status === "SUCCESSFUL") {
      await supabase.rpc("finalize_external_transfer", {
        p_transfer_id: row.id,
        p_final_status: "completed",
        p_flutterwave_reference: String(verification.data.id),
        p_flutterwave_status: verification.data.status,
        p_failure_reason: null,
      });
      resolved++;
    } else if (verification.data.status === "FAILED") {
      await supabase.rpc("finalize_external_transfer", {
        p_transfer_id: row.id,
        p_final_status: "failed",
        p_flutterwave_reference: String(verification.data.id),
        p_flutterwave_status: verification.data.status,
        p_failure_reason:
          verification.data.complete_message || "Transfer failed",
      });
      resolved++;
    }
  }
  return resolved;
}

async function cronHandler(req, res) {
  /*if (
    //process.env.VERCEL_ENV === "production" &&
    req.headers["x-vercel-cron"] !== "1" &&
    req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return res.status(401).json({ error: "Unauthorized" });
  }*/

  /*const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }*/
  const resolved = await reconcileStuckTransfers();
  res.json({ resolved });
}

module.exports = {
  processTransferEvent,
  reconcileStuckTransfers,
  cronHandler,
};

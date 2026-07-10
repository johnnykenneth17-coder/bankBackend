// transfer-webhook-service.js
// Handles Flutterwave's outbound-transfer webhooks: "transfer.completed"
// (fired for both eventual success and eventual failure — check
// data.status). This is the confirmed-outcome path for money leaving the
// platform; the worker's own status re-check (external-transfer-worker.js)
// is the fallback if this webhook is delayed or never arrives.
//
// Deliberately mirrors deposit-webhook-service.js: same signature
// verification, same flutterwave_webhook_logs dedup table (webhook_id is
// UNIQUE there), same "never trust the webhook body, verify with the API"
// principle. Kept as a separate module because deposit and outbound
// transfer are different money-movement directions with different
// completion functions (process_deposit vs complete_external_transfer/
// fail_external_transfer) — merging them risked exactly the kind of
// bug this codebase already has plenty of (wrong function called for
// the wrong direction of money).

const { createClient } = require("@supabase/supabase-js");
const flutterwaveService = require("./flutterwave-service");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

async function handleFlutterwaveTransferWebhook(req, res) {
  const signature = req.headers["verif-hash"];
  const payload = req.body;

  if (!flutterwaveService.verifyWebhookSignature(signature)) {
    console.warn("[TRANSFER-WEBHOOK] Rejected: invalid or missing verif-hash");
    return res.status(401).json({ error: "Invalid signature" });
  }

  const event = payload && payload.event;
  const data = payload && payload.data;
  if (!event || !data || !data.id || !data.reference) {
    console.warn("[TRANSFER-WEBHOOK] Rejected: malformed payload");
    return res.status(400).json({ error: "Malformed payload" });
  }

  if (event !== "transfer.completed") {
    return res.status(200).json({ status: "ignored" });
  }

  const { data: logRow, error: logErr } = await supabase
    .from("flutterwave_webhook_logs")
    .insert({
      webhook_id: `transfer-${data.id}`,
      event_type: event,
      transfer_reference: data.reference,
      flutterwave_reference: String(data.id),
      status: "received",
      payload,
      signature,
      ip_address: req.ip,
    })
    .select()
    .single();

  if (logErr) {
    if (logErr.code === "23505") {
      const { data: existing } = await supabase
        .from("flutterwave_webhook_logs")
        .select("processed")
        .eq("webhook_id", `transfer-${data.id}`)
        .single();
      if (existing && existing.processed) {
        return res.status(200).json({ status: "duplicate" });
      }
      // logged before but not finished — fall through and retry
    } else {
      console.error("[TRANSFER-WEBHOOK] Failed to write webhook log:", logErr);
      return res.status(200).json({ status: "log_error" });
    }
  }

  const webhookLogId = (logRow && logRow.id) || null;

  // Never trust the webhook body's status — re-verify with Flutterwave.
  const statusCheck = await flutterwaveService.getTransferStatus(data.id);

  if (!statusCheck.success) {
    if (webhookLogId) {
      await supabase
        .from("flutterwave_webhook_logs")
        .update({
          status: "verification_failed",
          error_message: statusCheck.error,
        })
        .eq("id", webhookLogId);
    }
    // Don't guess — the retry worker's own periodic status check will
    // pick this transfer up regardless of whether this webhook resolves.
    return res
      .status(200)
      .json({ status: "verification_failed_will_retry_via_worker" });
  }

  const { data: transfer, error: transferErr } = await supabase
    .from("flutterwave_transfers")
    .select("id, status")
    .eq("transaction_reference", data.reference)
    .single();

  if (transferErr || !transfer) {
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
    await supabase.from("reconciliation_alerts").insert({
      user_id: null,
      operational_balance: 0,
      ledger_balance: 0,
      difference: statusCheck.data.amount || 0,
      status: "open",
      severity: "high",
      notes: `Transfer webhook for Flutterwave reference ${data.id} / our reference ${data.reference} has no matching flutterwave_transfers row.`,
    });
    return res.status(200).json({ status: "no_matching_transfer" });
  }

  if (
    ["completed", "failed", "reversed", "cancelled"].includes(transfer.status)
  ) {
    if (webhookLogId) {
      await supabase
        .from("flutterwave_webhook_logs")
        .update({
          status: "already_terminal",
          processed: true,
          processed_at: new Date().toISOString(),
        })
        .eq("id", webhookLogId);
    }
    return res.status(200).json({ status: "already_terminal" });
  }

  if (statusCheck.data.status === "SUCCESSFUL") {
    const { error: rpcErr } = await supabase.rpc("complete_external_transfer", {
      p_transfer_id: transfer.id,
      p_flw_transaction_id: String(statusCheck.data.id),
      p_flw_status: statusCheck.data.status,
    });
    if (rpcErr) {
      console.error(
        "[TRANSFER-WEBHOOK] complete_external_transfer failed:",
        rpcErr,
      );
      if (webhookLogId) {
        await supabase
          .from("flutterwave_webhook_logs")
          .update({ status: "failed", error_message: rpcErr.message })
          .eq("id", webhookLogId);
      }
      return res
        .status(200)
        .json({ status: "completion_failed_will_retry_via_worker" });
    }
  } else if (statusCheck.data.status === "FAILED") {
    const { error: rpcErr } = await supabase.rpc("fail_external_transfer", {
      p_transfer_id: transfer.id,
      p_reason:
        statusCheck.data.complete_message || "Flutterwave reported FAILED",
      p_failure_code: "FLW_FAILED",
    });
    if (rpcErr) {
      console.error(
        "[TRANSFER-WEBHOOK] fail_external_transfer failed:",
        rpcErr,
      );
      if (webhookLogId) {
        await supabase
          .from("flutterwave_webhook_logs")
          .update({ status: "failed", error_message: rpcErr.message })
          .eq("id", webhookLogId);
      }
      return res
        .status(200)
        .json({ status: "failure_release_failed_will_retry_via_worker" });
    }
  } else {
    // Still NEW/PENDING despite a transfer.completed event — leave it
    // to the worker's status re-check rather than acting on ambiguity.
    if (webhookLogId) {
      await supabase
        .from("flutterwave_webhook_logs")
        .update({
          status: "ambiguous_status",
          processed: true,
          processed_at: new Date().toISOString(),
        })
        .eq("id", webhookLogId);
    }
    return res.status(200).json({ status: "ambiguous_status" });
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

  return res.status(200).json({ status: "ok" });
}

module.exports = { handleFlutterwaveTransferWebhook };

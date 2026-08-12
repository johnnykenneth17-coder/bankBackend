// ============================================================
// ADD THIS IMPORT at the top of transfer-finalization.js
// ============================================================
const accountResolutionCache = require("./account-resolution-cache");

// ============================================================
// INSIDE finalizeVerifiedTransfer(), AFTER the successful
// complete_external_transfer RPC call, add:
// ============================================================

// After: if (verified.status === "SUCCESSFUL") { ... rpc call ... }
// Add this block inside the success branch:

if (verified.status === "SUCCESSFUL") {
  // ... existing RPC and notification code ...

  // ── NEW: Cache receiver details + save as beneficiary ──────
  // After a successful external transfer, store the receiver's
  // details so the sender (and the system) can resolve them
  // instantly next time without calling Flutterwave/Paystack.
  const { data: fullTransfer } = await supabase
    .from("flutterwave_transfers")
    .select(
      "user_id, beneficiary_name, account_number, bank_code, bank_name",
    )
    .eq("transaction_reference", reference)
    .single();

  if (fullTransfer) {
    accountResolutionCache
      .cacheTransferReceiver({
        userId: fullTransfer.user_id,
        receiverName: fullTransfer.beneficiary_name,
        receiverAccount: fullTransfer.account_number,
        receiverBankCode: fullTransfer.bank_code,
        receiverBankName: fullTransfer.bank_name,
      })
      .catch((err) =>
        console.error("[FINALIZE] Cache receiver failed:", err),
      );
  }
}
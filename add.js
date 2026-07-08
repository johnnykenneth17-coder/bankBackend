// ============================================================
// REPLACEMENT for the "INITIATE FLUTTERWAVE TRANSFER" section in
// index.js (the block starting at the comment
// "// INITIATE FLUTTERWAVE TRANSFER" and running through the
// releaseReservedFunds() function, roughly lines 17443–17920 in the
// uploaded file). Delete that entire block and paste this in its
// place. Everything before it (bank list, /api/flutterwave/banks,
// /api/flutterwave/verify-account) and validateUserTransferLimits /
// validateLimits / updateUserTransferLimits stay as-is — this only
// replaces the transfer route itself and the two helper functions it
// called that were never defined (getTransferFeePercentage,
// createTransferLedgerEntries) and the fake-transaction wrapper
// (begin_transaction/commit_transaction/rollback_transaction, which
// also don't exist as RPCs).
//
// What changed and why:
//   - PIN is now required IN this route and verified server-side
//     before any money moves. Previously PIN was only checked by a
//     separate client-called endpoint the transfer route never
//     consulted, so calling this endpoint directly skipped PIN
//     entirely.
//   - The whole reserve step (balance check, row lock, reservation,
//     transaction + ledger rows) is now one call to
//     reserve_external_transfer() (see 010_atomic_transfers.sql) —
//     a real Postgres row-locked transaction, not five separate
//     supabase-js calls wrapped in RPCs that don't exist.
//   - The Flutterwave API call result is treated as "processing",
//     never as final — the transfer stays "initiated"/"processing"
//     until the webhook (transfer-webhook-handler.js) verifies the
//     real outcome and calls finalize_external_transfer().
//   - Fee percentage now reads from admin_settings
//     (flutterwave_transfer_fee_percentage), which already exists in
//     your schema and was already being seeded — just never read.
// ============================================================

app.post(
  "/api/flutterwave/transfer",
  authenticate,
  checkAccountFrozen,
  preventConcurrentTransfer,
  releaseTransactionLock,
  async (req, res) => {
    const {
      account_number,
      bank_code,
      bank_name,
      amount,
      narration,
      beneficiary_name,
      pin,
    } = req.body;

    const requestId =
      req.headers["idempotency-key"] || req.body.idempotency_key || crypto.randomUUID();

    try {
      // ============================================================
      // 1. VALIDATE INPUT
      // ============================================================
      if (!account_number || !bank_code || !amount || !beneficiary_name) {
        return res.status(400).json({
          error: "Missing required fields",
          code: "MISSING_FIELDS",
          required: ["account_number", "bank_code", "amount", "beneficiary_name"],
        });
      }

      if (!/^\d{10}$/.test(account_number)) {
        return res.status(400).json({
          error: "Invalid account number format",
          code: "INVALID_ACCOUNT_NUMBER",
        });
      }

      if (amount <= 0) {
        return res.status(400).json({ error: "Invalid amount", code: "INVALID_AMOUNT" });
      }

      if (!pin || !/^\d{4}$/.test(pin)) {
        return res.status(400).json({
          error: "Transaction PIN is required",
          code: "PIN_REQUIRED",
        });
      }

      // ============================================================
      // 2. IDEMPOTENCY (fast-path short-circuit; reserve_external_transfer
      // also enforces this atomically, this just saves a round trip on
      // a known double-click)
      // ============================================================
      const { data: existingTransfer } = await supabase
        .from("flutterwave_transfers")
        .select("id, status, transaction_reference, amount, fee_amount, beneficiary_name, bank_name, account_number")
        .eq("request_id_key", requestId)
        .maybeSingle();

      if (existingTransfer) {
        return res.json({
          success: true,
          message: "Transfer already submitted",
          data: {
            transfer_id: existingTransfer.id,
            transaction_reference: existingTransfer.transaction_reference,
            amount: existingTransfer.amount,
            fee: existingTransfer.fee_amount,
            beneficiary_name: existingTransfer.beneficiary_name,
            bank_name: existingTransfer.bank_name,
            account_number: existingTransfer.account_number,
            status: existingTransfer.status,
          },
        });
      }

      // ============================================================
      // 3. VERIFY PIN — server-side, before anything else touches money.
      // Reuses the same transfer_pin / pin_attempts fields the
      // /user/verify-transfer-pin endpoint uses, so a freeze from one
      // path is honored by the other.
      // ============================================================
      const { data: pinUser, error: pinUserErr } = await supabase
        .from("users")
        .select("transfer_pin, pin_attempts")
        .eq("id", req.user.id)
        .single();

      if (pinUserErr || !pinUser || !pinUser.transfer_pin) {
        return res.status(400).json({
          error: "Transfer PIN not set",
          code: "PIN_NOT_SET",
        });
      }

      if ((pinUser.pin_attempts || 0) >= 4) {
        return res.status(403).json({
          error: "Too many incorrect PIN attempts. Account frozen.",
          code: "PIN_FROZEN",
        });
      }

      const pinValid = await bcrypt.compare(pin, pinUser.transfer_pin);
      if (!pinValid) {
        const newAttempts = (pinUser.pin_attempts || 0) + 1;
        await supabase
          .from("users")
          .update({ pin_attempts: newAttempts, last_pin_attempt: new Date().toISOString() })
          .eq("id", req.user.id);

        if (newAttempts >= 4) {
          await supabase.from("users").update({ is_frozen: true }).eq("id", req.user.id);
        }

        return res.status(401).json({
          error: "Incorrect PIN",
          code: "INVALID_PIN",
          attempts_remaining: Math.max(0, 4 - newAttempts),
        });
      }

      await supabase
        .from("users")
        .update({ pin_attempts: 0, last_pin_attempt: null })
        .eq("id", req.user.id);

      // ============================================================
      // 4. VALIDATE LIMITS
      // ============================================================
      const limits = await validateUserTransferLimits(req.user.id, amount);
      if (!limits.allowed) {
        return res.status(400).json({
          error: limits.reason,
          code: limits.code,
          limit: limits.limit,
          used: limits.used,
        });
      }

      // ============================================================
      // 5. GET USER'S CHECKING ACCOUNT
      // ============================================================
      const { data: account, error: accError } = await supabase
        .from("accounts")
        .select("id")
        .eq("user_id", req.user.id)
        .eq("account_type", "checking")
        .single();

      if (accError || !account) {
        return res.status(404).json({ error: "Account not found", code: "ACCOUNT_NOT_FOUND" });
      }

      // ============================================================
      // 6. CALCULATE FEE
      // ============================================================
      const { data: feeSetting } = await supabase
        .from("admin_settings")
        .select("setting_value")
        .eq("setting_key", "flutterwave_transfer_fee_percentage")
        .maybeSingle();
      const feePercentage = feeSetting ? parseFloat(feeSetting.setting_value) : 0.5;
      const feeAmount = Math.round(amount * (feePercentage / 100) * 100) / 100;

      const transactionReference = generateTransferReference();

      // ============================================================
      // 7. RESERVE FUNDS ATOMICALLY (row-locked, single DB call)
      // ============================================================
      const { data: reserveResult, error: reserveError } = await supabase.rpc(
        "reserve_external_transfer",
        {
          p_request_id: requestId,
          p_user_id: req.user.id,
          p_from_account_id: account.id,
          p_amount: amount,
          p_fee_amount: feeAmount,
          p_transaction_reference: transactionReference,
          p_beneficiary_name: beneficiary_name,
          p_bank_code: bank_code,
          p_bank_name: bank_name,
          p_account_number: account_number,
          p_narration: narration || `Transfer to ${beneficiary_name}`,
          p_ip_address: req.ip,
          p_user_agent: req.headers["user-agent"],
          p_device_fingerprint: req.headers["x-device-fingerprint"] || null,
        },
      );

      if (reserveError) {
        console.error("Reserve external transfer error:", reserveError);
        if (reserveError.message?.includes("Insufficient balance")) {
          return res.status(400).json({
            error: "Insufficient balance",
            code: "INSUFFICIENT_BALANCE",
          });
        }
        return res.status(500).json({
          error: "Transfer failed",
          code: "TRANSFER_FAILED",
          message: reserveError.message,
        });
      }

      await updateUserTransferLimits(req.user.id, amount);

      await supabase.from("notifications").insert({
        user_id: req.user.id,
        title: "External Transfer Initiated",
        message: `Your transfer of ₦${amount.toLocaleString()} to ${beneficiary_name} has been initiated.`,
        type: "info",
        created_at: new Date().toISOString(),
      });

      // ============================================================
      // 8. CALL FLUTTERWAVE (async — response is "processing", not final)
      // ============================================================
      processFlutterwaveTransfer(reserveResult.transfer_id, {
        amount,
        narration,
        beneficiary_name,
        account_number,
        bank_code,
        transactionReference,
      });

      // ============================================================
      // 9. RESPOND
      // ============================================================
      res.json({
        success: true,
        message: "Transfer initiated successfully",
        data: {
          transfer_id: reserveResult.transfer_id,
          transaction_reference: transactionReference,
          amount,
          fee: feeAmount,
          total_deducted: amount + feeAmount,
          beneficiary_name,
          bank_name,
          account_number,
          status: "processing",
          new_available_balance: reserveResult.available_balance,
          estimated_completion: "2-3 minutes",
        },
      });
    } catch (error) {
      console.error("Transfer error:", error);
      res.status(500).json({
        error: "Transfer failed",
        code: "TRANSFER_FAILED",
        message: error.message,
      });
    }
  },
);

// ============================================================
// HELPER FUNCTIONS
// ============================================================

function generateTransferReference() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const random = Math.random().toString(36).substring(2, 10).toUpperCase();
  return `FEE-TRF-${year}${month}${day}-${random}`;
}

async function validateUserTransferLimits(userId, amount) {
  const today = new Date();
  const todayStr = today.toISOString().split("T")[0];

  const { data: limits, error } = await supabase
    .from("flutterwave_transfer_limits")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (error && error.code === "PGRST116") {
    const { data: newLimits } = await supabase
      .from("flutterwave_transfer_limits")
      .insert({
        user_id: userId,
        daily_limit: 500000,
        monthly_limit: 5000000,
        single_transaction_limit: 1000000,
        daily_reset_date: todayStr,
        monthly_reset_date: todayStr,
      })
      .select()
      .single();

    return validateLimits(newLimits, amount, todayStr);
  }

  if (error) throw error;
  return validateLimits(limits, amount, todayStr);
}

function validateLimits(limits, amount, todayStr) {
  if (amount > limits.single_transaction_limit) {
    return {
      allowed: false,
      code: "SINGLE_LIMIT_EXCEEDED",
      reason: `Single transaction limit is ₦${limits.single_transaction_limit.toLocaleString()}`,
      limit: limits.single_transaction_limit,
    };
  }

  let dailyUsed = limits.daily_used;
  if (limits.daily_reset_date !== todayStr) dailyUsed = 0;

  if (dailyUsed + amount > limits.daily_limit) {
    return {
      allowed: false,
      code: "DAILY_LIMIT_EXCEEDED",
      reason: `Daily transfer limit is ₦${limits.daily_limit.toLocaleString()}`,
      limit: limits.daily_limit,
      used: dailyUsed,
    };
  }

  let monthlyUsed = limits.monthly_used;
  if (limits.monthly_reset_date !== todayStr.slice(0, 7)) monthlyUsed = 0;

  if (monthlyUsed + amount > limits.monthly_limit) {
    return {
      allowed: false,
      code: "MONTHLY_LIMIT_EXCEEDED",
      reason: `Monthly transfer limit is ₦${limits.monthly_limit.toLocaleString()}`,
      limit: limits.monthly_limit,
      used: monthlyUsed,
    };
  }

  return { allowed: true };
}

async function updateUserTransferLimits(userId, amount) {
  const todayStr = new Date().toISOString().split("T")[0];
  const { data: limits } = await supabase
    .from("flutterwave_transfer_limits")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (!limits) return;

  const dailyUsed = limits.daily_reset_date === todayStr ? limits.daily_used + amount : amount;
  const monthlyUsed =
    limits.monthly_reset_date?.slice(0, 7) === todayStr.slice(0, 7)
      ? limits.monthly_used + amount
      : amount;

  await supabase
    .from("flutterwave_transfer_limits")
    .update({
      daily_used: dailyUsed,
      daily_reset_date: todayStr,
      monthly_used: monthlyUsed,
      monthly_reset_date: todayStr,
      last_updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);
}

// Fire-and-forget: calls Flutterwave, records whatever reference/status
// it hands back for tracing, but NEVER marks the transfer completed or
// failed here — only finalize_external_transfer() (driven by the
// verified webhook, or the reconciliation sweep) does that. If the API
// call itself fails outright (network error, 4xx from Flutterwave
// before it even queues the payout), that IS a definitive failure, so
// this path does call finalize_external_transfer with 'failed' to
// release the reservation immediately instead of leaving the user's
// funds stuck for the full reconciliation window.
async function processFlutterwaveTransfer(transferId, details) {
  const result = await flutterwaveService.initiateTransfer({
    accountNumber: details.account_number,
    bankCode: details.bank_code,
    amount: details.amount,
    narration: details.narration,
    beneficiaryName: details.beneficiary_name,
    reference: details.transactionReference,
    callbackUrl: process.env.FLUTTERWAVE_WEBHOOK_URL,
  });

  if (!result.success) {
    await supabase.rpc("finalize_external_transfer", {
      p_transfer_id: transferId,
      p_final_status: "failed",
      p_flutterwave_reference: null,
      p_flutterwave_status: null,
      p_failure_reason: result.error,
    });
    return;
  }

  await supabase
    .from("flutterwave_transfers")
    .update({
      flutterwave_reference: String(result.data.id),
      flutterwave_status: result.data.status,
      status: "processing",
      processed_at: new Date().toISOString(),
    })
    .eq("id", transferId);
}
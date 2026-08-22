

// ============================================================
// 1) REPLACES app.post("/api/user/savings/start", ...) — index.js
//    lines ~8932-9355 (the whole handler, from `"/api/user/savings/
//    start",` through its closing `);`). Duplicate-plan pre-checks
//    (the switch(type) block for fixed/savebox/target/spare_change)
//    move INTO the RPCs, so delete that block from index.js too —
//    it's now dead code, left here as a comment only for reference.
// ============================================================


// ============================================================
// 2) REPLACES app.post("/api/user/savings/spare-change/process", ...)
//    — index.js lines ~8713-8846.
//
//    IMPORTANT integration note: pass the ORIGINATING transfer's own
//    request id as `source_transaction_id` in the body from wherever
//    this route is called after a transfer completes (the
//    /api/user/transfer route already generates a `requestId` for
//    process_transfer — thread that same value through). That's what
//    makes a retried transfer-completion call idempotent here too,
//    instead of generating a fresh random id every call (which would
//    make the idempotency check a no-op).


// ============================================================
// 3) REPLACES app.post("/api/user/savings/:type/:id/withdraw", ...)
//    — index.js lines ~9893-10224 (the live one; the earlier
//    commented-out block at ~9667-9890 can be deleted outright, it's
//    dead code already).
// ============================================================


// ============================================================
// 4) REPLACES app.post("/api/user/process-withdrawal", ...) —
//    index.js lines ~8628-8706.
// ============================================================


// ============================================================
// 5) REPLACES app.post("/api/sys/users/:userId/update-balance", ...)
//    — index.js lines ~16122-16224.
// ============================================================
app.post(
  "/api/sys/users/:userId/update-balance",
  authenticate,
  authorizeAdmin,
  requirePermission("accounts:update-balance"),
  async (req, res) => {
    const requestId = req.headers["idempotency-key"] || req.body.requestId || crypto.randomUUID();

    try {
      const { userId } = req.params;
      const { account_id, amount, action, make_it_look_like_transfer, from_user_id, description } = req.body;

      const { data, error } = await supabase.rpc("process_admin_balance_adjustment", {
        p_request_id: requestId,
        p_admin_id: req.user.id,
        p_target_user_id: userId,
        p_account_id: account_id,
        p_amount: amount,
        p_action: action,
        p_description: description || null,
        p_make_it_look_like_transfer: !!make_it_look_like_transfer,
        p_from_user_id: from_user_id || null,
      });

      if (error) {
        const code = errCode(error);
        if (code) return res.status(mapStatus(code)).json({ error: FRIENDLY[code] });
        console.error("Admin update balance error:", error);
        return res.status(500).json({ error: "Failed to update balance" });
      }

      // Notification + admin_actions log stay in JS — unchanged.
      await supabase.from("notifications").insert({
        user_id: userId,
        title: "Balance Updated",
        message: `Your account balance has been updated. New balance: ₦${data.new_balance.toFixed(2)}`,
        type: "info",
      });

      await supabase.from("admin_actions").insert({
        admin_id: req.user.id,
        action_type: "update_balance",
        target_user_id: userId,
        details: { account_id, amount, action, make_it_look_like_transfer, from_user_id },
      });

      res.json({
        message: "Balance updated successfully",
        new_balance: data.new_balance,
        duplicate: !!data.duplicate,
      });
    } catch (error) {
      console.error("Admin update balance error:", error);
      res.status(500).json({ error: "Failed to update balance" });
    }
  },
);
// index.js - Update the harvest withdrawal approval endpoint
app.post(
  "/api/sys/harvest-withdrawal/:requestId/approve",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    const { requestId } = req.params;

    try {
      console.log(`Admin ${req.user.id} approving withdrawal request ${requestId}`);

      // Get the request with all related data
      const { data: request, error: fetchError } = await supabase
        .from("harvest_withdrawal_requests")
        .select(
          `
          *,
          users:user_id (
            id, 
            email, 
            first_name, 
            last_name
          ),
          user_harvest_enrollments:enrollment_id (
            id, 
            total_saved,
            user_id,
            plan_id,
            status
          )
        `,
        )
        .eq("id", requestId)
        .single();

      if (fetchError || !request) {
        console.error("Request not found:", fetchError);
        return res.status(404).json({ error: "Request not found" });
      }

      if (request.status !== "pending") {
        return res.status(400).json({ error: "Request already processed" });
      }

      // Get user's primary account
      const { data: account, error: accError } = await supabase
        .from("accounts")
        .select("*")
        .eq("user_id", request.user_id)
        .eq("account_type", "checking")
        .single();

      if (accError || !account) {
        console.error("User account not found:", accError);
        return res.status(404).json({ error: "User account not found" });
      }

      // ========== REFUND THE AMOUNT TO USER'S ACCOUNT ==========
      const refundAmount = request.amount || 0;
      const newBalance = (account.balance || 0) + refundAmount;
      const newAvailable = (account.available_balance || 0) + refundAmount;

      const { error: updateBalanceError } = await supabase
        .from("accounts")
        .update({
          balance: newBalance,
          available_balance: newAvailable,
          updated_at: new Date().toISOString(),
        })
        .eq("id", account.id);

      if (updateBalanceError) {
        console.error("Balance update error:", updateBalanceError);
        return res.status(500).json({ error: "Failed to update balance" });
      }

      console.log(`✅ Refunded ₦${refundAmount} to user ${request.user_id}. New balance: ₦${newAvailable}`);

      // ========== DEDUCT FROM HARVEST POOL ACCOUNT ==========
      const { data: harvestPool } = await supabase
        .from("savings_pool_accounts")
        .select("*")
        .eq("account_type", "harvest_pool")
        .single();

      if (harvestPool) {
        const newPoolBalance = harvestPool.balance - refundAmount;
        await supabase
          .from("savings_pool_accounts")
          .update({
            balance: newPoolBalance,
            available_balance: newPoolBalance,
            updated_at: new Date().toISOString(),
          })
          .eq("id", harvestPool.id);
        
        console.log(`✅ Deducted ₦${refundAmount} from harvest_pool. New balance: ₦${newPoolBalance}`);
      }

      // Update harvest enrollment status to "withdrawn"
      const { error: updateEnrollmentError } = await supabase
        .from("user_harvest_enrollments")
        .update({
          status: "withdrawn",
          auto_save: false,
          updated_at: new Date().toISOString(),
        })
        .eq("id", request.enrollment_id);

      if (updateEnrollmentError) {
        console.error("Enrollment update error:", updateEnrollmentError);
      }

      // Update request status
      const { error: updateRequestError } = await supabase
        .from("harvest_withdrawal_requests")
        .update({
          status: "approved",
          processed_at: new Date().toISOString(),
          processed_by: req.user.id,
          admin_note: `Approved by ${req.user.email}`,
        })
        .eq("id", requestId);

      if (updateRequestError) {
        console.error("Request update error:", updateRequestError);
        return res.status(500).json({ error: "Failed to update request status" });
      }

      // Create refund transaction
      const { error: transError } = await supabase.from("transactions").insert({
        to_account_id: account.id,
        to_user_id: request.user_id,
        amount: refundAmount,
        description: `Harvest Plan Withdrawal (Admin Approved) - Request ID: ${requestId}`,
        transaction_type: "savings_withdrawal",
        status: "completed",
        completed_at: new Date().toISOString(),
        is_admin_adjusted: true,
        admin_note: `Harvest withdrawal approved by ${req.user.email}`,
      });

      if (transError) {
        console.error("Transaction creation error:", transError);
      }

      // Create savings transaction record
      await supabase.from("savings_transactions").insert({
        user_id: request.user_id,
        savings_type: "harvest",
        savings_id: request.enrollment_id,
        amount: refundAmount,
        transaction_type: "withdrawal",
        description: `Withdrawn from Harvest Plan via admin approval`,
        processed_by: req.user.id,
        processed_at: new Date().toISOString(),
      });

      // Send notification to user
      await supabase.from("notifications").insert({
        user_id: request.user_id,
        title: "Harvest Plan Withdrawal Approved ✅",
        message: `Your Harvest Plan withdrawal request has been approved. ₦${refundAmount.toLocaleString()} has been returned to your account.`,
        type: "success",
        created_at: new Date().toISOString(),
      });

      // Log admin action
      await supabase.from("admin_actions").insert({
        admin_id: req.user.id,
        action_type: "approve_harvest_withdrawal",
        target_user_id: request.user_id,
        details: { request_id: requestId, amount: refundAmount },
        ip_address: req.ip,
        created_at: new Date().toISOString(),
      });

      console.log(`Withdrawal ${requestId} approved successfully`);
      res.json({
        success: true,
        message: "Withdrawal approved and funds returned",
        amount_refunded: refundAmount,
      });
    } catch (error) {
      console.error("Approve withdrawal error:", error);
      res.status(500).json({ error: error.message });
    }
  }
);
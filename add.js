// ADMIN: Get harvest plan withdrawal requests
app.get(
  "/api/admin/harvest-withdrawal-requests",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { data: requests, error } = await supabase
        .from("harvest_withdrawal_requests")
        .select(`
          *,
          users!inner(id, email, first_name, last_name, phone),
          user_harvest_enrollments!inner(
            id, 
            total_saved, 
            days_completed,
            harvest_plans!inner(name, daily_amount, duration_days)
          )
        `)
        .eq("status", "pending")
        .order("created_at", { ascending: false });

      if (error) throw error;

      res.json({ requests: requests || [] });
    } catch (error) {
      console.error("Error fetching withdrawal requests:", error);
      res.status(500).json({ error: "Failed to fetch withdrawal requests" });
    }
  }
);

// USER: Request harvest plan withdrawal (requires admin approval)
app.post(
  "/api/user/savings/harvest/:id/request-withdrawal",
  authenticate,
  async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;

    try {
      // Get harvest enrollment
      const { data: enrollment, error: hError } = await supabase
        .from("user_harvest_enrollments")
        .select(`
          *,
          harvest_plans!inner(name, daily_amount, duration_days)
        `)
        .eq("id", id)
        .eq("user_id", req.user.id)
        .single();

      if (hError || !enrollment) {
        return res.status(404).json({ error: "Harvest plan not found" });
      }

      // Check if already completed or cancelled
      if (enrollment.status !== "active") {
        return res.status(400).json({ error: "Cannot request withdrawal for this plan" });
      }

      // Check if withdrawal request already exists
      const { data: existing } = await supabase
        .from("harvest_withdrawal_requests")
        .select("id")
        .eq("enrollment_id", id)
        .eq("status", "pending")
        .single();

      if (existing) {
        return res.status(400).json({ error: "Withdrawal request already pending" });
      }

      // Create withdrawal request
      const { data: request, error } = await supabase
        .from("harvest_withdrawal_requests")
        .insert({
          user_id: req.user.id,
          enrollment_id: id,
          amount: enrollment.total_saved,
          reason: reason || "No reason provided",
          status: "pending",
        })
        .select()
        .single();

      if (error) throw error;

      // Create notification
      await supabase.from("notifications").insert({
        user_id: req.user.id,
        title: "Withdrawal Request Submitted",
        message: `Your Harvest Plan withdrawal request for ₦${(enrollment.total_saved || 0).toLocaleString()} has been submitted for admin approval.`,
        type: "info",
      });

      res.json({
        success: true,
        message: "Withdrawal request submitted. Admin will review your request.",
        request,
      });
    } catch (error) {
      console.error("Withdrawal request error:", error);
      res.status(500).json({ error: "Failed to submit withdrawal request" });
    }
  }
);

// ADMIN: Approve harvest withdrawal
app.post(
  "/api/admin/harvest-withdrawal/:requestId/approve",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    const { requestId } = req.params;

    try {
      const { data: request, error: fetchError } = await supabase
        .from("harvest_withdrawal_requests")
        .select(`
          *,
          users!inner(id, email, first_name, last_name),
          user_harvest_enrollments!inner(
            id, 
            total_saved,
            user_id
          )
        `)
        .eq("id", requestId)
        .single();

      if (fetchError || !request) {
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
        return res.status(404).json({ error: "User account not found" });
      }

      // Refund the amount to user's account
      const newBalance = account.balance + request.amount;
      const newAvailable = account.available_balance + request.amount;

      await supabase
        .from("accounts")
        .update({
          balance: newBalance,
          available_balance: newAvailable,
          updated_at: new Date().toISOString(),
        })
        .eq("id", account.id);

      // Update harvest enrollment status to "withdrawn"
      await supabase
        .from("user_harvest_enrollments")
        .update({
          status: "withdrawn",
          updated_at: new Date().toISOString(),
        })
        .eq("id", request.enrollment_id);

      // Update request status
      await supabase
        .from("harvest_withdrawal_requests")
        .update({
          status: "approved",
          processed_at: new Date().toISOString(),
          processed_by: req.user.id,
          admin_note: `Approved by ${req.user.email}`,
        })
        .eq("id", requestId);

      // Create refund transaction
      await supabase.from("transactions").insert({
        to_account_id: account.id,
        to_user_id: request.user_id,
        amount: request.amount,
        description: "Harvest Plan Withdrawal (Admin Approved)",
        transaction_type: "savings_withdrawal",
        status: "completed",
        completed_at: new Date().toISOString(),
        is_admin_adjusted: true,
        admin_note: `Harvest withdrawal approved by ${req.user.email}`,
      });

      // Send notification to user
      await supabase.from("notifications").insert({
        user_id: request.user_id,
        title: "Withdrawal Request Approved ✅",
        message: `Your Harvest Plan withdrawal of ₦${(request.amount || 0).toLocaleString()} has been approved. Funds have been returned to your account.`,
        type: "success",
      });

      res.json({ success: true, message: "Withdrawal approved and funds returned" });
    } catch (error) {
      console.error("Approve withdrawal error:", error);
      res.status(500).json({ error: "Failed to approve withdrawal" });
    }
  }
);

// ADMIN: Reject harvest withdrawal
app.post(
  "/api/admin/harvest-withdrawal/:requestId/reject",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    const { requestId } = req.params;
    const { reason } = req.body;

    try {
      const { data: request, error: fetchError } = await supabase
        .from("harvest_withdrawal_requests")
        .select(`
          *,
          users!inner(id, email, first_name, last_name)
        `)
        .eq("id", requestId)
        .single();

      if (fetchError || !request) {
        return res.status(404).json({ error: "Request not found" });
      }

      if (request.status !== "pending") {
        return res.status(400).json({ error: "Request already processed" });
      }

      // Update request status
      await supabase
        .from("harvest_withdrawal_requests")
        .update({
          status: "rejected",
          processed_at: new Date().toISOString(),
          processed_by: req.user.id,
          admin_note: reason || `Rejected by ${req.user.email}`,
        })
        .eq("id", requestId);

      // Send notification to user
      await supabase.from("notifications").insert({
        user_id: request.user_id,
        title: "Withdrawal Request Rejected ❌",
        message: `Your Harvest Plan withdrawal request was rejected. Reason: ${reason || "Not specified"}. Please continue your savings plan.`,
        type: "error",
      });

      res.json({ success: true, message: "Withdrawal request rejected" });
    } catch (error) {
      console.error("Reject withdrawal error:", error);
      res.status(500).json({ error: "Failed to reject withdrawal" });
    }
  }
);
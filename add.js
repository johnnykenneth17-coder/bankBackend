// ==================== HARVEST PLAN ADD UP SAVINGS ====================

// Add up savings to harvest plan
app.post(
  "/api/user/savings/harvest/:id/add-up",
  authenticate,
  checkAccountFrozen,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { amount } = req.body;

      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Invalid amount" });
      }

      // Get harvest enrollment
      const { data: enrollment, error: hError } = await supabase
        .from("user_harvest_enrollments")
        .select(`
          *,
          users!inner(id, email, first_name, last_name, is_frozen),
          harvest_plans!inner(
            id, 
            name, 
            daily_amount, 
            duration_days, 
            total_amount,
            reward_items
          )
        `)
        .eq("id", id)
        .eq("user_id", req.user.id)
        .single();

      if (hError || !enrollment) {
        return res.status(404).json({ error: "Harvest plan not found" });
      }

      if (enrollment.status !== "active") {
        return res.status(400).json({ error: "Cannot add to this savings plan" });
      }

      if (enrollment.users?.is_frozen) {
        return res.status(403).json({ error: "Account frozen" });
      }

      // Get user's primary account
      const { data: account, error: accError } = await supabase
        .from("accounts")
        .select("*")
        .eq("user_id", req.user.id)
        .eq("account_type", "checking")
        .single();

      if (accError || !account) {
        return res.status(404).json({ error: "Account not found" });
      }

      // Check if sufficient balance
      if (account.available_balance < amount) {
        return res.status(400).json({ error: "Insufficient funds" });
      }

      // Calculate how many days this amount represents
      const dailyAmount = enrollment.daily_amount;
      const additionalDays = Math.floor(amount / dailyAmount);
      const remainingAmount = amount % dailyAmount;
      
      // Calculate new totals
      const planTotalDays = enrollment.harvest_plans.duration_days;
      const currentDaysCompleted = enrollment.days_completed || 0;
      const newDaysCompleted = Math.min(
        currentDaysCompleted + additionalDays,
        planTotalDays
      );
      
      // Calculate new total saved
      const newTotalSaved = (enrollment.total_saved || 0) + amount;
      
      // Check if user would exceed total savings amount
      const planTotalAmount = enrollment.harvest_plans.total_amount;
      if (newTotalSaved > planTotalAmount) {
        const maxAllowed = planTotalAmount - (enrollment.total_saved || 0);
        return res.status(400).json({
          error: "amount_exceeds_limit",
          message: `Adding ₦${amount.toLocaleString()} would exceed your plan's total savings target. Maximum additional amount: ₦${maxAllowed.toLocaleString()}`,
          max_allowed: maxAllowed
        });
      }

      // Deduct amount from user's account
      const newBalance = account.balance - amount;
      const newAvailable = account.available_balance - amount;

      const { error: updateBalanceError } = await supabase
        .from("accounts")
        .update({
          balance: newBalance,
          available_balance: newAvailable,
          updated_at: new Date().toISOString()
        })
        .eq("id", account.id);

      if (updateBalanceError) throw updateBalanceError;

      // Calculate progress for notifications
      const wasCompleted = newDaysCompleted >= planTotalDays;
      const progressBefore = (currentDaysCompleted / planTotalDays) * 100;
      const progressAfter = (newDaysCompleted / planTotalDays) * 100;

      // Update enrollment
      const { error: updateError } = await supabase
        .from("user_harvest_enrollments")
        .update({
          total_saved: newTotalSaved,
          days_completed: newDaysCompleted,
          updated_at: new Date().toISOString(),
          status: wasCompleted ? "completed" : "active"
        })
        .eq("id", id);

      if (updateError) throw updateError;

      // Create transaction record
      const transactionId = `ADDUP${Date.now()}${Math.floor(Math.random() * 10000)}`;
      await supabase.from("transactions").insert({
        transaction_id: transactionId,
        from_account_id: account.id,
        from_user_id: req.user.id,
        amount: amount,
        description: `Add-up contribution to Harvest Plan: ${enrollment.harvest_plans.name}`,
        transaction_type: "savings_add_up",
        status: "completed",
        completed_at: new Date().toISOString(),
        created_at: new Date().toISOString()
      });

      // Create savings transaction record
      await supabase.from("savings_transactions").insert({
        user_id: req.user.id,
        savings_type: "harvest",
        savings_id: id,
        amount: amount,
        transaction_type: "add_up",
        description: `One-time add-up contribution of ₦${amount.toLocaleString()} (${additionalDays} days equivalent)`
      });

      // Create notification for user
      await supabase.from("notifications").insert({
        user_id: req.user.id,
        title: "Add-Up Contribution Successful",
        message: `You added ₦${amount.toLocaleString()} to your ${enrollment.harvest_plans.name} plan. ${additionalDays} days of savings added!`,
        type: "success",
        created_at: new Date().toISOString()
      });

      // Log security event
      await logSecurityEvent(req.user.id, "harvest_plan_add_up", {
        plan_id: id,
        plan_name: enrollment.harvest_plans.name,
        amount: amount,
        additional_days: additionalDays,
        new_total_saved: newTotalSaved,
        new_days_completed: newDaysCompleted
      });

      res.json({
        success: true,
        message: `Successfully added ₦${amount.toLocaleString()} to your harvest plan!`,
        data: {
          amount_added: amount,
          additional_days: additionalDays,
          remaining_amount: remainingAmount,
          total_saved: newTotalSaved,
          days_completed: newDaysCompleted,
          total_days: planTotalDays,
          progress_percent: (newDaysCompleted / planTotalDays) * 100,
          was_completed: wasCompleted
        }
      });
    } catch (error) {
      console.error("Add up savings error:", error);
      res.status(500).json({ error: "Failed to add savings: " + error.message });
    }
  }
);

// Get harvest plan add-up summary (for displaying potential additional days)
app.get(
  "/api/user/savings/harvest/:id/add-up-summary",
  authenticate,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { amount } = req.query;

      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Invalid amount" });
      }

      // Get harvest enrollment
      const { data: enrollment, error: hError } = await supabase
        .from("user_harvest_enrollments")
        .select(`
          *,
          harvest_plans!inner(
            daily_amount,
            duration_days,
            total_amount
          )
        `)
        .eq("id", id)
        .eq("user_id", req.user.id)
        .single();

      if (hError || !enrollment) {
        return res.status(404).json({ error: "Harvest plan not found" });
      }

      const dailyAmount = enrollment.daily_amount;
      const additionalDays = Math.floor(amount / dailyAmount);
      const remainingAmount = amount % dailyAmount;
      const newTotalSaved = (enrollment.total_saved || 0) + amount;
      const newDaysCompleted = Math.min(
        (enrollment.days_completed || 0) + additionalDays,
        enrollment.harvest_plans.duration_days
      );
      
      const planTotalAmount = enrollment.harvest_plans.total_amount;
      const exceedsLimit = newTotalSaved > planTotalAmount;
      const maxAllowed = planTotalAmount - (enrollment.total_saved || 0);

      res.json({
        success: true,
        summary: {
          amount: amount,
          daily_amount: dailyAmount,
          additional_days: additionalDays,
          remaining_amount: remainingAmount,
          current_saved: enrollment.total_saved || 0,
          new_total_saved: newTotalSaved,
          current_days: enrollment.days_completed || 0,
          new_days: newDaysCompleted,
          total_days: enrollment.harvest_plans.duration_days,
          exceeds_limit: exceedsLimit,
          max_allowed: maxAllowed
        }
      });
    } catch (error) {
      console.error("Add up summary error:", error);
      res.status(500).json({ error: "Failed to calculate summary" });
    }
  }
);
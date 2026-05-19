


// Execute add-up savings (with PIN verification)
app.post(
  "/api/user/savings/harvest/:id/add-up",
  authenticate,
  checkAccountFrozen,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { amount, pin } = req.body;

      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Invalid amount" });
      }

      // Verify PIN first
      const { data: user, error: userError } = await supabase
        .from("users")
        .select("transfer_pin, pin_attempts, last_pin_attempt")
        .eq("id", req.user.id)
        .single();

      if (userError) {
        return res.status(500).json({ error: "Failed to verify PIN" });
      }

      if (!user.transfer_pin) {
        return res.status(400).json({ error: "PIN_NOT_SET", message: "Please set a transfer PIN first" });
      }

      // Check PIN attempts
      const maxAttempts = 4;
      const attemptWindow = 15 * 60 * 1000;

      if (user.pin_attempts >= maxAttempts) {
        const lastAttempt = new Date(user.last_pin_attempt);
        if (Date.now() - lastAttempt < attemptWindow) {
          return res.status(429).json({ 
            error: "Too many incorrect PIN attempts. Please try again later.",
            frozen: true
          });
        } else {
          await supabase
            .from("users")
            .update({ pin_attempts: 0 })
            .eq("id", req.user.id);
        }
      }

      const isValidPin = await bcrypt.compare(pin, user.transfer_pin);

      if (!isValidPin) {
        const newAttempts = (user.pin_attempts || 0) + 1;
        const updates = { pin_attempts: newAttempts, last_pin_attempt: new Date() };
        
        if (newAttempts >= maxAttempts) {
          updates.is_frozen = true;
          updates.freeze_reason = "Too many incorrect PIN attempts - Contact support to unfreeze";
          updates.unfreeze_method = "support";
        }
        
        await supabase.from("users").update(updates).eq("id", req.user.id);
        
        return res.status(401).json({ 
          error: "Incorrect PIN",
          attempts_remaining: maxAttempts - newAttempts,
          frozen: newAttempts >= maxAttempts
        });
      }

      // Reset PIN attempts on success
      await supabase
        .from("users")
        .update({ pin_attempts: 0, last_pin_attempt: null })
        .eq("id", req.user.id);

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

      // Calculate how many days this amount represents
      const dailyAmount = enrollment.daily_amount;
      const additionalDays = Math.floor(amount / dailyAmount);
      const remainingAmount = amount % dailyAmount;
      
      // Calculate new totals
      const planTotalAmount = enrollment.harvest_plans.total_amount;
      const currentSaved = enrollment.total_saved || 0;
      const newTotalSaved = currentSaved + amount;
      
      // Check if would exceed total savings amount
      if (newTotalSaved > planTotalAmount) {
        const maxAllowed = planTotalAmount - currentSaved;
        return res.status(400).json({
          error: "amount_exceeds_limit",
          message: `Adding ₦${amount.toLocaleString()} would exceed your plan's total savings target. Maximum additional amount: ₦${maxAllowed.toLocaleString()}`,
          max_allowed: maxAllowed
        });
      }

      // Check if sufficient balance
      if (account.available_balance < amount) {
        return res.status(400).json({ error: "Insufficient funds" });
      }

      // Calculate new days completed
      const currentDaysCompleted = Math.floor(currentSaved / dailyAmount);
      const newDaysCompleted = Math.min(
        currentDaysCompleted + additionalDays,
        enrollment.harvest_plans.duration_days
      );
      
      const wasCompleted = newDaysCompleted >= enrollment.harvest_plans.duration_days;

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
      await supabase.from("security_logs").insert({
        user_id: req.user.id,
        event_type: "harvest_plan_add_up",
        details: {
          plan_id: id,
          plan_name: enrollment.harvest_plans.name,
          amount: amount,
          additional_days: additionalDays,
          new_total_saved: newTotalSaved,
          new_days_completed: newDaysCompleted
        },
        ip_address: req.ip
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
          total_days: enrollment.harvest_plans.duration_days,
          progress_percent: (newDaysCompleted / enrollment.harvest_plans.duration_days) * 100,
          was_completed: wasCompleted
        }
      });
    } catch (error) {
      console.error("Add up savings error:", error);
      res.status(500).json({ error: "Failed to add savings: " + error.message });
    }
  }
);
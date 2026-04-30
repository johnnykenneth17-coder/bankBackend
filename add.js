// ==================== SAVINGS SYSTEM ROUTES - ADD ALL OF THESE ====================

// Get savings summary (check if user has active plans)
app.get("/api/user/savings/summary", authenticate, async (req, res) => {
  try {
    console.log("Fetching savings summary for user:", req.user.id);

    const [harvest, fixed, savebox, target, spareChange] = await Promise.all([
      supabase
        .from("user_harvest_enrollments")
        .select("id, status, auto_save")
        .eq("user_id", req.user.id)
        .eq("status", "active")
        .maybeSingle(),
      supabase
        .from("fixed_savings")
        .select("id, status, auto_save")
        .eq("user_id", req.user.id)
        .in("status", ["active", "matured"])
        .maybeSingle(),
      supabase
        .from("savebox_savings")
        .select("id, status, auto_save")
        .eq("user_id", req.user.id)
        .eq("status", "active")
        .maybeSingle(),
      supabase
        .from("target_savings")
        .select("id, status, auto_save")
        .eq("user_id", req.user.id)
        .eq("status", "active")
        .maybeSingle(),
      supabase
        .from("spare_change_savings")
        .select("id, status, auto_save")
        .eq("user_id", req.user.id)
        .eq("status", "active")
        .maybeSingle(),
    ]);

    res.json({
      active_plans: {
        harvest: harvest.data || null,
        fixed: fixed.data || null,
        savebox: savebox.data || null,
        target: target.data || null,
        spare_change: spareChange.data || null,
      },
    });
  } catch (error) {
    console.error("Savings summary error:", error);
    res
      .status(500)
      .json({ error: "Failed to get savings summary: " + error.message });
  }
});

// Get user's savings (all types)
app.get("/api/user/savings", authenticate, async (req, res) => {
  try {
    console.log("Fetching all savings for user:", req.user.id);

    const [harvest, fixed, savebox, target, spareChange] = await Promise.all([
      supabase
        .from("user_harvest_enrollments")
        .select("*, harvest_plans(name, daily_amount, duration_days)")
        .eq("user_id", req.user.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("fixed_savings")
        .select("*")
        .eq("user_id", req.user.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("savebox_savings")
        .select("*")
        .eq("user_id", req.user.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("target_savings")
        .select("*")
        .eq("user_id", req.user.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("spare_change_savings")
        .select("*")
        .eq("user_id", req.user.id)
        .order("created_at", { ascending: false }),
    ]);

    const allSavings = [];

    // Format harvest
    (harvest.data || []).forEach((h) => {
      allSavings.push({
        id: h.id,
        type: "harvest",
        plan_name: h.harvest_plans?.name || "Harvest Plan",
        amount: h.total_saved || 0,
        total_saved: h.total_saved || 0,
        daily_amount: h.daily_amount,
        days_completed: h.days_completed || 0,
        total_days: h.harvest_plans?.duration_days || 0,
        start_date: h.start_date,
        expected_end_date: h.expected_end_date,
        status: h.status,
        auto_save: h.auto_save || false,
        created_at: h.created_at,
      });
    });

    // Format fixed
    (fixed.data || []).forEach((f) => {
      const maturityDate = new Date(f.maturity_date);
      const today = new Date();
      const isMatured = maturityDate <= today;

      allSavings.push({
        id: f.id,
        type: "fixed",
        amount: f.amount || 0,
        current_saved: f.current_saved || 0,
        daily_amount: f.daily_amount || f.amount / 30,
        interest_rate: f.interest_rate || 5,
        start_date: f.start_date,
        maturity_date: f.maturity_date,
        next_free_withdrawal_date: f.next_free_withdrawal_date,
        status: isMatured ? "matured" : f.status,
        auto_save: f.auto_save || true,
        created_at: f.created_at,
      });
    });

    // Format savebox
    (savebox.data || []).forEach((s) => {
      allSavings.push({
        id: s.id,
        type: "savebox",
        amount: s.amount || 0,
        current_saved: s.current_saved || 0,
        daily_amount: s.daily_amount || s.amount / 90,
        target_date: s.target_date,
        early_withdrawal_fee_percent: s.early_withdrawal_fee_percent || 4,
        status: s.status,
        auto_save: s.auto_save || true,
        created_at: s.created_at,
      });
    });

    // Format target
    (target.data || []).forEach((t) => {
      const withdrawalDate = new Date(t.withdrawal_date);
      const today = new Date();
      const canWithdraw =
        withdrawalDate <= today && t.current_saved >= t.target_amount;

      allSavings.push({
        id: t.id,
        type: "target",
        target_amount: t.target_amount || 0,
        current_saved: t.current_saved || 0,
        daily_savings_amount: t.daily_savings_amount,
        withdrawal_date: t.withdrawal_date,
        days_remaining: t.days_remaining || 0,
        status: canWithdraw ? "completed" : t.status,
        auto_save: t.auto_save || true,
        can_withdraw: canWithdraw,
        created_at: t.created_at,
      });
    });

    // Format spare_change
    (spareChange.data || []).forEach((s) => {
      allSavings.push({
        id: s.id,
        type: "spare_change",
        current_saved: s.current_saved || 0,
        total_saved: s.total_saved || 0,
        percentage_rate: s.percentage_rate || 3,
        status: s.status,
        auto_save: s.auto_save || true,
        created_at: s.created_at,
      });
    });

    res.json(allSavings);
  } catch (error) {
    console.error("Get savings error:", error);
    res
      .status(500)
      .json({ error: "Failed to fetch savings: " + error.message });
  }
});

// Get single savings details
app.get("/api/user/savings/:type/:id", authenticate, async (req, res) => {
  const { type, id } = req.params;

  try {
    console.log(`Fetching ${type} savings ${id} for user:`, req.user.id);

    let result = null;

    switch (type) {
      case "harvest":
        const { data: harvest, error: hError } = await supabase
          .from("user_harvest_enrollments")
          .select(
            "*, harvest_plans(name, daily_amount, duration_days, reward_items)",
          )
          .eq("id", id)
          .eq("user_id", req.user.id)
          .single();
        if (hError) throw hError;
        result = {
          ...harvest,
          type: "harvest",
          plan_name: harvest.harvest_plans?.name,
          total_days: harvest.harvest_plans?.duration_days,
          reward_items: harvest.harvest_plans?.reward_items,
        };
        break;

      case "fixed":
        const { data: fixed, error: fError } = await supabase
          .from("fixed_savings")
          .select("*")
          .eq("id", id)
          .eq("user_id", req.user.id)
          .single();
        if (fError) throw fError;

        const maturityDate = new Date(fixed.maturity_date);
        const today = new Date();
        const daysUntilMaturity = Math.max(
          0,
          Math.ceil((maturityDate - today) / (1000 * 60 * 60 * 24)),
        );
        const isMatured = maturityDate <= today;
        const freeWithdrawalDate = new Date(fixed.next_free_withdrawal_date);
        const isFreeWithdrawal = isMatured && today <= freeWithdrawalDate;
        const interestEarned =
          (fixed.current_saved || 0) * (fixed.interest_rate / 100);

        result = {
          ...fixed,
          type: "fixed",
          days_until_maturity: daysUntilMaturity,
          status: isMatured ? "matured" : fixed.status,
          is_free_withdrawal_available: isFreeWithdrawal,
          interest_earned: interestEarned,
          total_with_interest: (fixed.current_saved || 0) + interestEarned,
          duration_days: 30,
        };
        break;

      case "savebox":
        const { data: savebox, error: sError } = await supabase
          .from("savebox_savings")
          .select("*")
          .eq("id", id)
          .eq("user_id", req.user.id)
          .single();
        if (sError) throw sError;
        result = { ...savebox, type: "savebox" };
        break;

      case "target":
        const { data: target, error: tError } = await supabase
          .from("target_savings")
          .select("*")
          .eq("id", id)
          .eq("user_id", req.user.id)
          .single();
        if (tError) throw tError;

        const withdrawalDate = new Date(target.withdrawal_date);
        const daysUntilWithdrawal = Math.max(
          0,
          Math.ceil((withdrawalDate - today) / (1000 * 60 * 60 * 24)),
        );
        const percentComplete =
          target.target_amount > 0
            ? (target.current_saved / target.target_amount) * 100
            : 0;
        const canWithdraw =
          withdrawalDate <= today &&
          target.current_saved >= target.target_amount;

        result = {
          ...target,
          type: "target",
          days_until_withdrawal: daysUntilWithdrawal,
          percent_complete: percentComplete,
          can_withdraw: canWithdraw,
          status: canWithdraw ? "completed" : target.status,
        };
        break;

      case "spare_change":
        const { data: spare, error: spError } = await supabase
          .from("spare_change_savings")
          .select("*")
          .eq("id", id)
          .eq("user_id", req.user.id)
          .single();
        if (spError) throw spError;
        result = { ...spare, type: "spare_change" };
        break;

      default:
        return res.status(400).json({ error: "Invalid savings type" });
    }

    res.json(result);
  } catch (error) {
    console.error("Get savings detail error:", error);
    res
      .status(500)
      .json({ error: "Failed to fetch savings details: " + error.message });
  }
});

// Start savings
app.post(
  "/api/user/savings/start",
  authenticate,
  checkAccountFrozen,
  async (req, res) => {
    const {
      type,
      amount,
      plan_id,
      target_withdrawal_date,
      auto_save = true,
    } = req.body;

    console.log("Starting savings:", {
      type,
      amount,
      plan_id,
      auto_save,
      userId: req.user.id,
    });

    try {
      // ========== DUPLICATE PLAN CHECK (except harvest which allows multiple) ==========
      if (type !== "harvest") {
        let existingQuery = null;

        switch (type) {
          case "fixed":
            const { data: existingFixed, error: eFixed } = await supabase
              .from("fixed_savings")
              .select("id, status")
              .eq("user_id", req.user.id)
              .in("status", ["active", "matured"]);
            if (existingFixed && existingFixed.length > 0) {
              return res.status(400).json({
                error:
                  "You already have an active Fixed Savings plan. Please complete or withdraw it before starting a new one.",
                existing_plan: existingFixed[0],
              });
            }
            break;

          case "savebox":
            const { data: existingSavebox, error: eSavebox } = await supabase
              .from("savebox_savings")
              .select("id, status")
              .eq("user_id", req.user.id)
              .eq("status", "active");
            if (existingSavebox && existingSavebox.length > 0) {
              return res.status(400).json({
                error:
                  "You already have an active SaveBox plan. Only one SaveBox plan is allowed per user.",
              });
            }
            break;

          case "target":
            const { data: existingTarget, error: eTarget } = await supabase
              .from("target_savings")
              .select("id, status")
              .eq("user_id", req.user.id)
              .eq("status", "active");
            if (existingTarget && existingTarget.length > 0) {
              return res.status(400).json({
                error:
                  "You already have an active Target Savings plan. Complete it before starting a new one.",
              });
            }
            break;

          case "spare_change":
            const { data: existingSpare, error: eSpare } = await supabase
              .from("spare_change_savings")
              .select("id, status")
              .eq("user_id", req.user.id)
              .eq("status", "active");
            if (existingSpare && existingSpare.length > 0) {
              return res.status(400).json({
                error: "You already have an active Spare Change Savings plan.",
              });
            }
            break;
        }
      }

      // ========== GET ACCOUNT ==========
      const { data: account, error: accError } = await supabase
        .from("accounts")
        .select("*")
        .eq("user_id", req.user.id)
        .eq("account_type", "checking")
        .single();

      if (accError || !account) {
        return res.status(404).json({ error: "Account not found" });
      }

      // ========== CHECK BALANCE (skip for spare_change) ==========
      if (type !== "spare_change") {
        if (!amount || amount <= 0) {
          return res.status(400).json({ error: "Invalid amount" });
        }
        if (account.available_balance < amount) {
          return res.status(400).json({ error: "Insufficient funds" });
        }
      }

      let savingsRecord;

      // ========== PROCESS BASED ON TYPE ==========
      switch (type) {
        case "harvest":
          const { data: plan, error: planError } = await supabase
            .from("harvest_plans")
            .select("*")
            .eq("id", plan_id)
            .single();

          if (planError) throw planError;

          const startDate = new Date();
          const endDate = new Date();
          endDate.setDate(endDate.getDate() + plan.duration_days);
          const nextDeduction = new Date();
          nextDeduction.setDate(nextDeduction.getDate() + 1);

          // Deduct initial amount
          await supabase
            .from("accounts")
            .update({
              balance: account.balance - amount,
              available_balance: account.available_balance - amount,
            })
            .eq("id", account.id);

          const { data: harvest, error: hError } = await supabase
            .from("user_harvest_enrollments")
            .insert({
              user_id: req.user.id,
              plan_id: plan_id,
              daily_amount: plan.daily_amount,
              total_saved: amount,
              days_completed: 1,
              start_date: startDate,
              expected_end_date: endDate,
              last_deduction_date: startDate,
              next_deduction_due: nextDeduction,
              auto_save: auto_save,
              status: "active",
            })
            .select()
            .single();

          if (hError) throw hError;
          savingsRecord = {
            ...harvest,
            plan_name: plan.name,
            duration_days: plan.duration_days,
          };
          break;

        case "fixed":
          // Deduct initial amount
          await supabase
            .from("accounts")
            .update({
              balance: account.balance - amount,
              available_balance: account.available_balance - amount,
            })
            .eq("id", account.id);

          const maturityDate = new Date();
          maturityDate.setDate(maturityDate.getDate() + 30);
          const freeWithdrawalDate = new Date();
          freeWithdrawalDate.setDate(freeWithdrawalDate.getDate() + 32);
          const dailyAmount = amount / 30;

          const { data: fixed, error: fError } = await supabase
            .from("fixed_savings")
            .insert({
              user_id: req.user.id,
              amount: amount,
              current_saved: amount,
              daily_amount: dailyAmount,
              last_deduction_date: new Date(),
              interest_rate: 5.0,
              start_date: new Date(),
              maturity_date: maturityDate,
              next_free_withdrawal_date: freeWithdrawalDate,
              auto_save: auto_save,
              status: "active",
            })
            .select()
            .single();

          if (fError) throw fError;
          savingsRecord = fixed;
          break;

        case "savebox":
          // Deduct initial amount
          await supabase
            .from("accounts")
            .update({
              balance: account.balance - amount,
              available_balance: account.available_balance - amount,
            })
            .eq("id", account.id);

          const targetDate = new Date();
          targetDate.setMonth(targetDate.getMonth() + 3);
          const saveboxDailyAmount = amount / 90;

          const { data: savebox, error: sError } = await supabase
            .from("savebox_savings")
            .insert({
              user_id: req.user.id,
              amount: amount,
              current_saved: amount,
              daily_amount: saveboxDailyAmount,
              last_deduction_date: new Date(),
              target_date: targetDate,
              early_withdrawal_fee_percent: 4.0,
              auto_save: auto_save,
              status: "active",
            })
            .select()
            .single();

          if (sError) throw sError;
          savingsRecord = savebox;
          break;

        case "target":
          // Deduct initial amount
          await supabase
            .from("accounts")
            .update({
              balance: account.balance - amount,
              available_balance: account.available_balance - amount,
            })
            .eq("id", account.id);

          const withdrawalDate = new Date(target_withdrawal_date);
          const daysUntil = Math.max(
            1,
            Math.ceil((withdrawalDate - new Date()) / (1000 * 60 * 60 * 24)),
          );
          const targetDailyAmount = amount / daysUntil;

          const { data: target, error: tError } = await supabase
            .from("target_savings")
            .insert({
              user_id: req.user.id,
              target_amount: amount,
              daily_savings_amount: targetDailyAmount,
              withdrawal_date: withdrawalDate,
              current_saved: amount,
              days_remaining: daysUntil - 1,
              last_deduction_date: new Date(),
              auto_save: auto_save,
              status: "active",
              target_met: false,
              withdrawn: false,
            })
            .select()
            .single();

          if (tError) throw tError;
          savingsRecord = target;
          break;

        case "spare_change":
          const { data: spare, error: spError } = await supabase
            .from("spare_change_savings")
            .insert({
              user_id: req.user.id,
              percentage_rate: 3.0,
              current_saved: 0,
              total_saved: 0,
              auto_save: auto_save,
              status: "active",
            })
            .select()
            .single();

          if (spError) throw spError;
          savingsRecord = spare;
          break;

        default:
          return res.status(400).json({ error: "Invalid savings type" });
      }

      // Create transaction record (skip for spare_change)
      if (type !== "spare_change") {
        await supabase.from("transactions").insert({
          from_account_id: account.id,
          from_user_id: req.user.id,
          amount: amount,
          description: `${type.charAt(0).toUpperCase() + type.slice(1)} Savings Initial Deposit`,
          transaction_type: "savings",
          status: "completed",
          completed_at: new Date(),
        });
      }

      // Create savings transaction
      await supabase.from("savings_transactions").insert({
        user_id: req.user.id,
        savings_type: type,
        savings_id: savingsRecord.id,
        amount: type !== "spare_change" ? amount : 0,
        transaction_type: "deposit",
        description: `Started ${type} savings`,
      });

      res.json({
        success: true,
        message: "Savings started successfully",
        savings: savingsRecord,
      });
    } catch (error) {
      console.error("Error starting savings:", error);
      res
        .status(500)
        .json({ error: "Failed to start savings: " + error.message });
    }
  },
);

// Toggle auto-save
app.post(
  "/api/user/savings/:type/:id/toggle-auto",
  authenticate,
  async (req, res) => {
    const { type, id } = req.params;
    const { auto_save } = req.body;

    try {
      let table;
      switch (type) {
        case "harvest":
          table = "user_harvest_enrollments";
          break;
        case "fixed":
          table = "fixed_savings";
          break;
        case "savebox":
          table = "savebox_savings";
          break;
        case "target":
          table = "target_savings";
          break;
        case "spare_change":
          table = "spare_change_savings";
          break;
        default:
          return res.status(400).json({ error: "Invalid savings type" });
      }

      const { error } = await supabase
        .from(table)
        .update({ auto_save: auto_save, updated_at: new Date() })
        .eq("id", id)
        .eq("user_id", req.user.id);

      if (error) throw error;

      res.json({
        success: true,
        message: auto_save ? "Auto-save enabled" : "Auto-save disabled",
        auto_save: auto_save,
      });
    } catch (error) {
      console.error("Toggle auto-save error:", error);
      res
        .status(500)
        .json({ error: "Failed to toggle auto-save: " + error.message });
    }
  },
);

// Withdraw from savings
app.post(
  "/api/user/savings/:type/:id/withdraw",
  authenticate,
  async (req, res) => {
    const { type, id } = req.params;

    try {
      let savingsRecord,
        account,
        withdrawAmount = 0,
        fee = 0;

      // Get the savings record based on type
      switch (type) {
        case "harvest":
          const { data: harvest, error: hError } = await supabase
            .from("user_harvest_enrollments")
            .select("*")
            .eq("id", id)
            .eq("user_id", req.user.id)
            .single();
          if (hError) throw hError;
          savingsRecord = harvest;
          withdrawAmount = harvest.total_saved || 0;
          break;

        case "fixed":
          const { data: fixed, error: fError } = await supabase
            .from("fixed_savings")
            .select("*")
            .eq("id", id)
            .eq("user_id", req.user.id)
            .single();
          if (fError) throw fError;

          const interest = fixed.current_saved * (fixed.interest_rate / 100);
          const today = new Date();
          const freeWithdrawalDate = new Date(fixed.next_free_withdrawal_date);
          const isFreeWithdrawal = today <= freeWithdrawalDate;

          withdrawAmount = fixed.current_saved + interest;
          if (!isFreeWithdrawal && fixed.status === "matured") {
            fee = withdrawAmount * 0.02;
            withdrawAmount -= fee;
          }
          savingsRecord = fixed;
          break;

        case "savebox":
          const { data: savebox, error: sError } = await supabase
            .from("savebox_savings")
            .select("*")
            .eq("id", id)
            .eq("user_id", req.user.id)
            .single();
          if (sError) throw sError;

          withdrawAmount = savebox.current_saved || 0;
          const isEarly = new Date() < new Date(savebox.target_date);
          if (isEarly) {
            fee = withdrawAmount * (savebox.early_withdrawal_fee_percent / 100);
            withdrawAmount -= fee;
          }
          savingsRecord = savebox;
          break;

        case "target":
          const { data: target, error: tError } = await supabase
            .from("target_savings")
            .select("*")
            .eq("id", id)
            .eq("user_id", req.user.id)
            .single();
          if (tError) throw tError;

          if (target.current_saved < target.target_amount) {
            return res.status(400).json({ error: "Target not yet reached" });
          }
          withdrawAmount = target.current_saved || 0;
          savingsRecord = target;
          break;

        case "spare_change":
          const { data: spare, error: spError } = await supabase
            .from("spare_change_savings")
            .select("*")
            .eq("id", id)
            .eq("user_id", req.user.id)
            .single();
          if (spError) throw spError;
          withdrawAmount = spare.current_saved || 0;
          savingsRecord = spare;
          break;

        default:
          return res.status(400).json({ error: "Invalid savings type" });
      }

      if (withdrawAmount <= 0) {
        return res.status(400).json({ error: "No funds to withdraw" });
      }

      // Get user's account
      const { data: userAccount, error: accError } = await supabase
        .from("accounts")
        .select("*")
        .eq("user_id", req.user.id)
        .eq("account_type", "checking")
        .single();

      if (accError || !userAccount) {
        return res.status(404).json({ error: "Account not found" });
      }
      account = userAccount;

      // Update account balance
      const newBalance = account.balance + withdrawAmount;
      const newAvailable = account.available_balance + withdrawAmount;

      await supabase
        .from("accounts")
        .update({ balance: newBalance, available_balance: newAvailable })
        .eq("id", account.id);

      // Update savings record status
      let table;
      switch (type) {
        case "harvest":
          table = "user_harvest_enrollments";
          break;
        case "fixed":
          table = "fixed_savings";
          break;
        case "savebox":
          table = "savebox_savings";
          break;
        case "target":
          table = "target_savings";
          break;
        case "spare_change":
          table = "spare_change_savings";
          break;
      }

      await supabase
        .from(table)
        .update({ status: "withdrawn", updated_at: new Date() })
        .eq("id", id);

      // Create withdrawal transaction
      await supabase.from("transactions").insert({
        to_account_id: account.id,
        to_user_id: req.user.id,
        amount: withdrawAmount,
        description: `${type.charAt(0).toUpperCase() + type.slice(1)} Savings Withdrawal${fee > 0 ? ` (Fee: ₦${fee.toFixed(2)})` : ""}`,
        transaction_type: "savings_withdrawal",
        status: "completed",
        completed_at: new Date(),
      });

      res.json({
        success: true,
        message: "Withdrawal completed successfully",
        amount_withdrawn: withdrawAmount,
        fee_charged: fee,
        new_balance: newAvailable,
      });
    } catch (error) {
      console.error("Withdrawal error:", error);
      res
        .status(500)
        .json({ error: "Failed to process withdrawal: " + error.message });
    }
  },
);

// Cancel savings plan
app.post(
  "/api/user/savings/:type/:id/cancel",
  authenticate,
  async (req, res) => {
    const { type, id } = req.params;

    try {
      let table;
      switch (type) {
        case "harvest":
          table = "user_harvest_enrollments";
          break;
        case "fixed":
          table = "fixed_savings";
          break;
        case "savebox":
          table = "savebox_savings";
          break;
        case "target":
          table = "target_savings";
          break;
        case "spare_change":
          table = "spare_change_savings";
          break;
        default:
          return res.status(400).json({ error: "Invalid savings type" });
      }

      const { error } = await supabase
        .from(table)
        .update({
          auto_save: false,
          status: "cancelled",
          updated_at: new Date(),
        })
        .eq("id", id)
        .eq("user_id", req.user.id);

      if (error) throw error;

      res.json({
        success: true,
        message:
          "Savings plan cancelled. Your saved funds remain available for withdrawal.",
      });
    } catch (error) {
      console.error("Cancel savings error:", error);
      res
        .status(500)
        .json({ error: "Failed to cancel savings plan: " + error.message });
    }
  },
);

// Get harvest plans for user
app.get("/api/user/harvest-plans", authenticate, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("harvest_plans")
      .select("*")
      .eq("is_active", true);

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    console.error("Get harvest plans error:", error);
    res.status(500).json({ error: "Failed to fetch harvest plans" });
  }
});

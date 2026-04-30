// ==================== SAVINGS ROUTES ====================


// Get savings summary (check if user has active plans) - SINGLE VERSION
app.get("/api/user/savings/summary", authenticate, async (req, res) => {
  try {
    console.log("Fetching savings summary for user:", req.user.id);
    
    const [harvest, fixed, savebox, target, spareChange] = await Promise.all([
      supabase
        .from("user_harvest_enrollments")
        .select("id, status, auto_save, total_saved")
        .eq("user_id", req.user.id)
        .eq("status", "active")
        .maybeSingle(),
      supabase
        .from("fixed_savings")
        .select("id, status, auto_save, current_saved, maturity_date")
        .eq("user_id", req.user.id)
        .in("status", ["active", "matured"])
        .maybeSingle(),
      supabase
        .from("savebox_savings")
        .select("id, status, auto_save, current_saved, target_date")
        .eq("user_id", req.user.id)
        .eq("status", "active")
        .maybeSingle(),
      supabase
        .from("target_savings")
        .select("id, status, auto_save, current_saved, target_amount, withdrawal_date")
        .eq("user_id", req.user.id)
        .eq("status", "active")
        .maybeSingle(),
      supabase
        .from("spare_change_savings")
        .select("id, status, auto_save, current_saved")
        .eq("user_id", req.user.id)
        .eq("status", "active")
        .maybeSingle(),
    ]);

    const totalSaved = 
      (harvest.data?.total_saved || 0) +
      (fixed.data?.current_saved || 0) +
      (savebox.data?.current_saved || 0) +
      (target.data?.current_saved || 0) +
      (spareChange.data?.current_saved || 0);

    console.log("Savings summary fetched successfully");
    
    res.json({
      total_saved: totalSaved,
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
    res.status(500).json({ error: "Failed to get savings summary: " + error.message });
  }
});




// Changed from 'summary' to 'status' to avoid keyword conflicts
app.get("/api/user/savings/status", authenticate, async (req, res) => {
  try {
    console.log("Fetching savings status for user:", req.user.id);
    
    const [harvest, fixed, savebox, target, spareChange] = await Promise.all([
      supabase
        .from("user_harvest_enrollments")
        .select("id, status, auto_save, total_saved")
        .eq("user_id", req.user.id)
        .eq("status", "active")
        .maybeSingle(),
      supabase
        .from("fixed_savings")
        .select("id, status, auto_save, current_saved, maturity_date")
        .eq("user_id", req.user.id)
        .in("status", ["active", "matured"])
        .maybeSingle(),
      supabase
        .from("savebox_savings")
        .select("id, status, auto_save, current_saved, target_date")
        .eq("user_id", req.user.id)
        .eq("status", "active")
        .maybeSingle(),
      supabase
        .from("target_savings")
        .select("id, status, auto_save, current_saved, target_amount, withdrawal_date")
        .eq("user_id", req.user.id)
        .eq("status", "active")
        .maybeSingle(),
      supabase
        .from("spare_change_savings")
        .select("id, status, auto_save, current_saved")
        .eq("user_id", req.user.id)
        .eq("status", "active")
        .maybeSingle(),
    ]);

    const totalSaved = 
      (harvest.data?.total_saved || 0) +
      (fixed.data?.current_saved || 0) +
      (savebox.data?.current_saved || 0) +
      (target.data?.current_saved || 0) +
      (spareChange.data?.current_saved || 0);

    console.log("Savings status fetched successfully");
    
    res.json({
      success: true,
      total_saved: totalSaved,
      has_active_harvest: !!harvest.data,
      has_active_fixed: !!fixed.data,
      has_active_savebox: !!savebox.data,
      has_active_target: !!target.data,
      has_active_spare_change: !!spareChange.data,
      active_plans: {
        harvest: harvest.data || null,
        fixed: fixed.data || null,
        savebox: savebox.data || null,
        target: target.data || null,
        spare_change: spareChange.data || null,
      },
    });
  } catch (error) {
    console.error("Savings status error:", error);
    res.status(500).json({ error: "Failed to get savings status: " + error.message });
  }
});


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
    console.error("Error fetching harvest plans:", error);
    res.status(500).json({ error: "Failed to fetch harvest plans" });
  }
});



// Get savings summary (check if user has active plans) - SINGLE VERSION
app.get("/api/user/savings/summary", authenticate, async (req, res) => {
  try {
    console.log("Fetching savings summary for user:", req.user.id);
    
    const [harvest, fixed, savebox, target, spareChange] = await Promise.all([
      supabase
        .from("user_harvest_enrollments")
        .select("id, status, auto_save, total_saved")
        .eq("user_id", req.user.id)
        .eq("status", "active")
        .maybeSingle(),
      supabase
        .from("fixed_savings")
        .select("id, status, auto_save, current_saved, maturity_date")
        .eq("user_id", req.user.id)
        .in("status", ["active", "matured"])
        .maybeSingle(),
      supabase
        .from("savebox_savings")
        .select("id, status, auto_save, current_saved, target_date")
        .eq("user_id", req.user.id)
        .eq("status", "active")
        .maybeSingle(),
      supabase
        .from("target_savings")
        .select("id, status, auto_save, current_saved, target_amount, withdrawal_date")
        .eq("user_id", req.user.id)
        .eq("status", "active")
        .maybeSingle(),
      supabase
        .from("spare_change_savings")
        .select("id, status, auto_save, current_saved")
        .eq("user_id", req.user.id)
        .eq("status", "active")
        .maybeSingle(),
    ]);

    const totalSaved = 
      (harvest.data?.total_saved || 0) +
      (fixed.data?.current_saved || 0) +
      (savebox.data?.current_saved || 0) +
      (target.data?.current_saved || 0) +
      (spareChange.data?.current_saved || 0);

    console.log("Savings summary fetched successfully");
    
    res.json({
      total_saved: totalSaved,
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
    res.status(500).json({ error: "Failed to get savings summary: " + error.message });
  }
});



// Start savings - WITH DUPLICATE PREVENTION
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

    try {
      // ========== DUPLICATE PLAN CHECK ==========
      // Harvest plans: multiple allowed (user can have multiple harvest plans)
      // Other plans: only ONE active plan per type

      if (type !== "harvest") {
        let existingQuery = null;
        let existingError = null;

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
                existing_plan: existingSavebox[0],
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
                existing_plan: existingTarget[0],
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
                existing_plan: existingSpare[0],
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

      // ========== CHECK BALANCE (skip for spare_change which has no initial deposit) ==========
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
          // Multiple harvest plans allowed - no duplicate check needed
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
          // No initial deduction for spare change
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




// Get all savings for user
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
    (harvest.data || []).forEach(h => {
      allSavings.push({
        id: h.id,
        type: "harvest",
        plan_name: h.harvest_plans?.name || "Harvest Plan",
        total_saved: h.total_saved || 0,
        daily_amount: h.daily_amount,
        days_completed: h.days_completed || 0,
        total_days: h.harvest_plans?.duration_days || 0,
        status: h.status,
        auto_save: h.auto_save || false,
        created_at: h.created_at,
      });
    });
    
    // Format fixed
    (fixed.data || []).forEach(f => {
      const today = new Date();
      const maturityDate = new Date(f.maturity_date);
      const isMatured = maturityDate <= today;
      
      allSavings.push({
        id: f.id,
        type: "fixed",
        amount: f.amount || 0,
        current_saved: f.current_saved || 0,
        daily_amount: f.daily_amount || (f.amount / 30),
        interest_rate: f.interest_rate || 5,
        maturity_date: f.maturity_date,
        status: isMatured ? "matured" : f.status,
        auto_save: f.auto_save || true,
        created_at: f.created_at,
      });
    });
    
    // Format savebox
    (savebox.data || []).forEach(s => {
      allSavings.push({
        id: s.id,
        type: "savebox",
        amount: s.amount || 0,
        current_saved: s.current_saved || 0,
        daily_amount: s.daily_amount || (s.amount / 90),
        target_date: s.target_date,
        early_withdrawal_fee_percent: s.early_withdrawal_fee_percent || 4,
        status: s.status,
        auto_save: s.auto_save || true,
        created_at: s.created_at,
      });
    });
    
    // Format target
    (target.data || []).forEach(t => {
      const withdrawalDate = new Date(t.withdrawal_date);
      const today = new Date();
      const canWithdraw = withdrawalDate <= today && (t.current_saved >= t.target_amount);
      
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
        created_at: t.created_at,
      });
    });
    
    // Format spare_change
    (spareChange.data || []).forEach(s => {
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
    res.status(500).json({ error: "Failed to fetch savings: " + error.message });
  }
});

// Get single savings details (FIXED - get specific savings by type and id)
app.get("/api/user/savings/:type/:id", authenticate, async (req, res) => {
  const { type, id } = req.params;
  
  try {
    console.log(`Fetching ${type} savings ${id} for user:`, req.user.id);
    
    let result = null;
    const today = new Date();
    
    switch(type) {
      case "harvest":
        const { data: harvest, error: hError } = await supabase
          .from("user_harvest_enrollments")
          .select("*, harvest_plans(name, daily_amount, duration_days, reward_items)")
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
        const daysUntilMaturity = Math.max(0, Math.ceil((maturityDate - today) / (1000 * 60 * 60 * 24)));
        const isMatured = maturityDate <= today;
        const freeWithdrawalDate = new Date(fixed.next_free_withdrawal_date);
        const isFreeWithdrawal = isMatured && today <= freeWithdrawalDate;
        const interestEarned = (fixed.current_saved || 0) * (fixed.interest_rate / 100);
        
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
        const daysUntilWithdrawal = Math.max(0, Math.ceil((withdrawalDate - today) / (1000 * 60 * 60 * 24)));
        const percentComplete = target.target_amount > 0 ? (target.current_saved / target.target_amount) * 100 : 0;
        const canWithdraw = withdrawalDate <= today && target.current_saved >= target.target_amount;
        
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
    res.status(500).json({ error: "Failed to fetch savings details: " + error.message });
  }
});

// Toggle auto-save for savings plan
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
      res.status(500).json({ error: "Failed to toggle auto-save" });
    }
  },
);

// Withdraw from savings (with fee calculation for SaveBox)
app.post(
  "/api/user/savings/:type/:id/withdraw",
  authenticate,
  async (req, res) => {
    const { type, id } = req.params;

    try {
      let savingsRecord, account;

      // Get the savings record based on type
      switch (type) {
        case "harvest":
          const { data: harvest, error: hError } = await supabase
            .from("user_harvest_enrollments")
            .select("*, users!inner(id, email, first_name, last_name)")
            .eq("id", id)
            .eq("user_id", req.user.id)
            .single();
          if (hError) throw hError;
          savingsRecord = harvest;
          break;
        case "fixed":
          const { data: fixed, error: fError } = await supabase
            .from("fixed_savings")
            .select("*, users!inner(id, email, first_name, last_name)")
            .eq("id", id)
            .eq("user_id", req.user.id)
            .single();
          if (fError) throw fError;
          savingsRecord = fixed;
          break;
        case "savebox":
          const { data: savebox, error: sError } = await supabase
            .from("savebox_savings")
            .select("*, users!inner(id, email, first_name, last_name)")
            .eq("id", id)
            .eq("user_id", req.user.id)
            .single();
          if (sError) throw sError;
          savingsRecord = savebox;
          break;
        case "target":
          const { data: target, error: tError } = await supabase
            .from("target_savings")
            .select("*, users!inner(id, email, first_name, last_name)")
            .eq("id", id)
            .eq("user_id", req.user.id)
            .single();
          if (tError) throw tError;
          savingsRecord = target;
          break;
        case "spare_change":
          const { data: spare, error: spError } = await supabase
            .from("spare_change_savings")
            .select("*, users!inner(id, email, first_name, last_name)")
            .eq("id", id)
            .eq("user_id", req.user.id)
            .single();
          if (spError) throw spError;
          savingsRecord = spare;
          break;
        default:
          return res.status(400).json({ error: "Invalid savings type" });
      }

      if (!savingsRecord) {
        return res.status(404).json({ error: "Savings record not found" });
      }

      // Get user's primary account
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

      let withdrawAmount = 0;
      let fee = 0;
      let feePercentage = 0;

      // Calculate withdrawal amount and fee
      switch (type) {
        case "harvest":
          withdrawAmount = savingsRecord.total_saved || 0;
          break;
        case "fixed":
          const interest =
            savingsRecord.current_saved * (savingsRecord.interest_rate / 100);
          const today = new Date();
          const isFreeWithdrawal =
            savingsRecord.status === "matured" &&
            today <= new Date(savingsRecord.next_free_withdrawal_date);

          if (isFreeWithdrawal) {
            withdrawAmount = savingsRecord.current_saved + interest;
            fee = 0;
          } else if (savingsRecord.status === "matured") {
            withdrawAmount = savingsRecord.current_saved + interest;
            fee = withdrawAmount * 0.02; // 2% fee after free period
            withdrawAmount -= fee;
          } else {
            return res.status(400).json({ error: "Savings not yet matured" });
          }
          break;
        case "savebox":
          withdrawAmount = savingsRecord.current_saved || 0;
          const isEarlyWithdrawal =
            new Date() < new Date(savingsRecord.target_date);
          if (isEarlyWithdrawal) {
            feePercentage = savingsRecord.early_withdrawal_fee_percent || 4;
            fee = withdrawAmount * (feePercentage / 100);
            withdrawAmount -= fee;
          }
          break;
        case "target":
          if (
            !savingsRecord.target_met &&
            savingsRecord.current_saved < savingsRecord.target_amount
          ) {
            return res.status(400).json({ error: "Target not yet reached" });
          }
          withdrawAmount = savingsRecord.current_saved || 0;
          break;
        case "spare_change":
          withdrawAmount = savingsRecord.current_saved || 0;
          break;
      }

      if (withdrawAmount <= 0) {
        return res.status(400).json({ error: "No funds to withdraw" });
      }

      // Update account balance
      const newBalance = account.balance + withdrawAmount;
      const newAvailable = account.available_balance + withdrawAmount;

      await supabase
        .from("accounts")
        .update({ balance: newBalance, available_balance: newAvailable })
        .eq("id", account.id);

      // Update savings record status
      await supabase
        .from(
          type === "harvest"
            ? "user_harvest_enrollments"
            : type === "fixed"
              ? "fixed_savings"
              : type === "savebox"
                ? "savebox_savings"
                : type === "target"
                  ? "target_savings"
                  : "spare_change_savings",
        )
        .update({
          status: "withdrawn",
          updated_at: new Date(),
        })
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

      // Create savings transaction record
      await supabase.from("savings_transactions").insert({
        user_id: req.user.id,
        savings_type: type,
        savings_id: id,
        amount: withdrawAmount,
        transaction_type: "withdrawal",
        description: `Withdrawn from ${type} savings${fee > 0 ? `, fee: ₦${fee.toFixed(2)}` : ""}`,
      });

      // Send email notification
      try {
        await transporter.sendMail({
          from: process.env.SMTP_FROM,
          to: savingsRecord.users?.email || req.user.email,
          subject: `${type.charAt(0).toUpperCase() + type.slice(1)} Savings Withdrawal`,
          html: `
                    <h2>Withdrawal Complete</h2>
                    <p>Dear ${savingsRecord.users?.first_name || req.user.first_name},</p>
                    <p>You have successfully withdrawn <strong>₦${withdrawAmount.toFixed(2)}</strong> from your ${type} savings.</p>
                    ${fee > 0 ? `<p>Withdrawal fee: <strong>₦${fee.toFixed(2)}</strong> (${feePercentage}%)</p>` : ""}
                    <p>Amount credited to your account: <strong>₦${withdrawAmount.toFixed(2)}</strong></p>
                    <p>Thank you for saving with us!</p>
                `,
        });
      } catch (emailError) {
        console.error("Email error:", emailError);
      }

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

// Cancel savings plan (stop auto-save but keep saved amount)
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
      res.status(500).json({ error: "Failed to cancel savings plan" });
    }
  },
);
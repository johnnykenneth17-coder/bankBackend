// ==================== SAVINGS SYSTEM ROUTES ====================

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
// ==================== SAVINGS ROUTES (CORRECTED) ====================

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

// Start savings (CORRECTED)
app.post("/api/user/savings/start", authenticate, checkAccountFrozen, async (req, res) => {
    const { type, amount, plan_id, target_withdrawal_date } = req.body;
    
    try {
        // Get primary account
        const { data: account, error: accError } = await supabase
            .from("accounts")
            .select("*")
            .eq("user_id", req.user.id)
            .eq("account_type", "checking")
            .single();
        
        if (accError || !account) {
            return res.status(404).json({ error: "Account not found" });
        }
        
        if (account.available_balance < amount) {
            return res.status(400).json({ error: "Insufficient funds" });
        }
        
        // Deduct amount
        await supabase
            .from("accounts")
            .update({
                balance: account.balance - amount,
                available_balance: account.available_balance - amount
            })
            .eq("id", account.id);
        
        let savingsRecord;
        let savingsType = type;
        
        switch(type) {
            case 'harvest':
                const { data: plan, error: planError } = await supabase
                    .from("harvest_plans")
                    .select("*")
                    .eq("id", plan_id)
                    .single();
                
                if (planError) throw planError;
                
                const startDate = new Date();
                const endDate = new Date();
                endDate.setDate(endDate.getDate() + plan.duration_days);
                
                const { data: harvest, error: hError } = await supabase
                    .from("user_harvest_enrollments")
                    .insert({
                        user_id: req.user.id,
                        plan_id: plan_id,
                        daily_amount: amount,
                        total_saved: amount,
                        days_completed: 1,
                        start_date: startDate,
                        expected_end_date: endDate,
                        last_deduction_date: startDate,
                        status: 'active'
                    })
                    .select()
                    .single();
                
                if (hError) throw hError;
                savingsRecord = harvest;
                break;
                
            case 'fixed':
                const maturityDate = new Date();
                maturityDate.setDate(maturityDate.getDate() + 30);
                const freeWithdrawalDate = new Date();
                freeWithdrawalDate.setDate(freeWithdrawalDate.getDate() + 32); // 30 days lock + 2 days free
                
                const { data: fixed, error: fError } = await supabase
                    .from("fixed_savings")
                    .insert({
                        user_id: req.user.id,
                        amount: amount,
                        interest_rate: 5.0,
                        start_date: new Date(),
                        maturity_date: maturityDate,
                        next_free_withdrawal_date: freeWithdrawalDate,
                        status: 'active'
                    })
                    .select()
                    .single();
                
                if (fError) throw fError;
                savingsRecord = fixed;
                break;
                
            case 'savebox':
                const targetDate = new Date();
                targetDate.setMonth(targetDate.getMonth() + 1);
                
                const { data: savebox, error: sError } = await supabase
                    .from("savebox_savings")
                    .insert({
                        user_id: req.user.id,
                        amount: amount,
                        target_date: targetDate,
                        early_withdrawal_fee_percent: 4.0,
                        status: 'active'
                    })
                    .select()
                    .single();
                
                if (sError) throw sError;
                savingsRecord = savebox;
                break;
                
            case 'target':
                const withdrawalDate = new Date(target_withdrawal_date);
                const daysUntil = Math.max(1, Math.ceil((withdrawalDate - new Date()) / (1000 * 60 * 60 * 24)));
                const dailyAmount = amount / daysUntil;
                
                const { data: target, error: tError } = await supabase
                    .from("target_savings")
                    .insert({
                        user_id: req.user.id,
                        target_amount: amount,
                        daily_savings_amount: dailyAmount,
                        withdrawal_date: withdrawalDate,
                        current_saved: amount,
                        days_remaining: daysUntil - 1,
                        status: 'active'
                    })
                    .select()
                    .single();
                
                if (tError) throw tError;
                savingsRecord = target;
                break;
        }
        
        // Create transaction record
        await supabase.from("transactions").insert({
            from_account_id: account.id,
            from_user_id: req.user.id,
            amount: amount,
            description: `${type.charAt(0).toUpperCase() + type.slice(1)} Savings Deposit`,
            transaction_type: "savings",
            status: "completed",
            completed_at: new Date()
        });
        
        // Create savings transaction
        await supabase.from("savings_transactions").insert({
            user_id: req.user.id,
            savings_type: type,
            savings_id: savingsRecord.id,
            amount: amount,
            transaction_type: "deposit",
            description: `Started ${type} savings`
        });
        
        // Return consistent response structure
        res.json({ 
            success: true, 
            message: "Savings started successfully", 
            savings: {
                id: savingsRecord.id,
                type: type,
                amount: amount,
                start_date: new Date().toISOString(),
                status: 'active'
            }
        });
        
    } catch (error) {
        console.error("Error starting savings:", error);
        res.status(500).json({ error: "Failed to start savings" });
    }
});

// Get user's savings (CORRECTED)
app.get("/api/user/savings", authenticate, async (req, res) => {
    try {
        const [harvest, fixed, savebox, target] = await Promise.all([
            supabase.from("user_harvest_enrollments").select("*, harvest_plans(name, daily_amount, duration_days)").eq("user_id", req.user.id).eq("status", "active"),
            supabase.from("fixed_savings").select("*").eq("user_id", req.user.id).in("status", ["active", "matured"]),
            supabase.from("savebox_savings").select("*").eq("user_id", req.user.id).eq("status", "active"),
            supabase.from("target_savings").select("*").eq("user_id", req.user.id).eq("status", "active")
        ]);
        
        const allSavings = [];
        
        // Format harvest plans
        (harvest.data || []).forEach(h => {
            allSavings.push({
                id: h.id,
                type: "harvest",
                plan_name: h.harvest_plans?.name || "Harvest Plan",
                amount: h.total_saved || 0,
                daily_amount: h.daily_amount,
                days_completed: h.days_completed,
                total_days: h.harvest_plans?.duration_days || 0,
                start_date: h.start_date,
                expected_end_date: h.expected_end_date,
                status: h.status
            });
        });
        
        // Format fixed savings
        (fixed.data || []).forEach(f => {
            allSavings.push({
                id: f.id,
                type: "fixed",
                amount: f.amount,
                interest_rate: f.interest_rate,
                start_date: f.start_date,
                maturity_date: f.maturity_date,
                next_free_withdrawal_date: f.next_free_withdrawal_date,
                status: f.status
            });
        });
        
        // Format savebox
        (savebox.data || []).forEach(s => {
            allSavings.push({
                id: s.id,
                type: "savebox",
                amount: s.amount,
                target_date: s.target_date,
                early_withdrawal_fee_percent: s.early_withdrawal_fee_percent,
                start_date: s.created_at,
                status: s.status
            });
        });
        
        // Format target savings
        (target.data || []).forEach(t => {
            allSavings.push({
                id: t.id,
                type: "target",
                target_amount: t.target_amount,
                current_saved: t.current_saved,
                daily_savings_amount: t.daily_savings_amount,
                withdrawal_date: t.withdrawal_date,
                days_remaining: t.days_remaining,
                start_date: t.created_at,
                status: t.status
            });
        });
        
        res.json(allSavings);
    } catch (error) {
        console.error("Error fetching savings:", error);
        res.status(500).json({ error: "Failed to fetch savings" });
    }
});
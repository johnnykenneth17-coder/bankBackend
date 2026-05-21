// Get account limits with tier information
app.get("/api/user/account-limits", authenticate, async (req, res) => {
    try {
        const userId = req.user.id;
        
        // Get user's tier
        const { data: user, error: userError } = await supabase
            .from("users")
            .select("account_tier")
            .eq("id", userId)
            .single();
        
        if (userError) throw userError;
        
        // Get tier limits
        const { data: tierLimits, error: limitsError } = await supabase
            .from("account_tier_limits")
            .select("*")
            .eq("tier", user.account_tier)
            .single();
        
        if (limitsError) throw limitsError;
        
        // Get user's total balance
        const { data: accounts } = await supabase
            .from("accounts")
            .select("balance")
            .eq("user_id", userId);
        
        const totalBalance = accounts?.reduce((sum, acc) => sum + (acc.balance || 0), 0) || 0;
        
        // Get today's transactions sum
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const { data: todayTxs } = await supabase
            .from("transactions")
            .select("amount")
            .eq("from_user_id", userId)
            .eq("status", "completed")
            .gte("created_at", today.toISOString());
        
        const dailyUsed = todayTxs?.reduce((sum, t) => sum + t.amount, 0) || 0;
        
        // Get this month's transactions sum
        const monthStart = new Date();
        monthStart.setDate(1);
        monthStart.setHours(0, 0, 0, 0);
        const { data: monthTxs } = await supabase
            .from("transactions")
            .select("amount")
            .eq("from_user_id", userId)
            .eq("status", "completed")
            .gte("created_at", monthStart.toISOString());
        
        const monthlyUsed = monthTxs?.reduce((sum, t) => sum + t.amount, 0) || 0;
        
        res.json({
            max_balance: tierLimits.max_balance,
            daily_limit: tierLimits.daily_transfer_limit,
            single_transfer_limit: tierLimits.single_transfer_limit,
            monthly_limit: tierLimits.monthly_transfer_limit,
            daily_used: dailyUsed,
            monthly_used: monthlyUsed,
            current_tier: user.account_tier,
            current_balance: totalBalance,
            balance_percentage: (totalBalance / tierLimits.max_balance) * 100
        });
    } catch (error) {
        console.error("Account limits error:", error);
        res.status(500).json({ error: "Failed to fetch limits" });
    }
});
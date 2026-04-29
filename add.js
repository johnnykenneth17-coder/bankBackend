// Check if user has transfer PIN
app.get("/api/user/has-pin", authenticate, async (req, res) => {
    try {
        const { data: user, error } = await supabase
            .from("users")
            .select("transfer_pin, transfer_pin_set_at")
            .eq("id", req.user.id)
            .single();
        
        if (error) throw error;
        
        res.json({ 
            has_pin: !!(user.transfer_pin && user.transfer_pin !== null),
            pin_set_at: user.transfer_pin_set_at
        });
    } catch (error) {
        console.error("Check PIN error:", error);
        res.status(500).json({ error: "Failed to check PIN status" });
    }
});

// Set/Update transfer PIN
app.post("/api/user/set-transfer-pin", authenticate, async (req, res) => {
    try {
        const { pin } = req.body;
        
        if (!pin || pin.length !== 4 || !/^\d{4}$/.test(pin)) {
            return res.status(400).json({ error: "PIN must be exactly 4 digits" });
        }
        
        // Hash the PIN before storing
        const hashedPin = await bcrypt.hash(pin, 10);
        
        const { error } = await supabase
            .from("users")
            .update({
                transfer_pin: hashedPin,
                transfer_pin_set_at: new Date(),
                pin_attempts: 0,
                last_pin_attempt: null
            })
            .eq("id", req.user.id);
        
        if (error) throw error;
        
        res.json({ success: true, message: "Transfer PIN set successfully" });
    } catch (error) {
        console.error("Set PIN error:", error);
        res.status(500).json({ error: "Failed to set transfer PIN" });
    }
});

// Verify transfer PIN
app.post("/api/user/verify-transfer-pin", authenticate, async (req, res) => {
    try {
        const { pin } = req.body;
        
        if (!pin || pin.length !== 4) {
            return res.status(400).json({ valid: false, error: "Invalid PIN format" });
        }
        
        const { data: user, error } = await supabase
            .from("users")
            .select("transfer_pin, pin_attempts, last_pin_attempt")
            .eq("id", req.user.id)
            .single();
        
        if (error) throw error;
        
        if (!user.transfer_pin) {
            return res.json({ valid: false, needs_setup: true });
        }
        
        // Check if account is already frozen due to PIN attempts
        if (user.pin_attempts >= 4) {
            return res.status(403).json({ 
                valid: false, 
                frozen: true,
                error: "Too many incorrect PIN attempts. Account frozen."
            });
        }
        
        const isValid = await bcrypt.compare(pin, user.transfer_pin);
        
        if (isValid) {
            // Reset attempts on successful verification
            await supabase
                .from("users")
                .update({ pin_attempts: 0, last_pin_attempt: null })
                .eq("id", req.user.id);
            
            res.json({ valid: true });
        } else {
            // Increment attempts
            const newAttempts = (user.pin_attempts || 0) + 1;
            const updates = { pin_attempts: newAttempts, last_pin_attempt: new Date() };
            
            if (newAttempts >= 4) {
                // Freeze account after 4 failed attempts
                updates.is_frozen = true;
                updates.freeze_reason = "Too many incorrect PIN attempts - Contact support to unfreeze";
                updates.unfreeze_method = "support";
            }
            
            await supabase
                .from("users")
                .update(updates)
                .eq("id", req.user.id);
            
            res.json({ 
                valid: false, 
                attempts_remaining: 4 - newAttempts,
                frozen: newAttempts >= 4
            });
        }
    } catch (error) {
        console.error("Verify PIN error:", error);
        res.status(500).json({ error: "PIN verification failed" });
    }
});

// Freeze account due to PIN attempts
app.post("/api/user/freeze-due-to-pin-attempts", authenticate, async (req, res) => {
    try {
        const { error } = await supabase
            .from("users")
            .update({
                is_frozen: true,
                freeze_reason: "Too many incorrect PIN attempts - Contact support",
                unfreeze_method: "support"
            })
            .eq("id", req.user.id);
        
        if (error) throw error;
        
        res.json({ success: true });
    } catch (error) {
        console.error("Freeze error:", error);
        res.status(500).json({ error: "Failed to freeze account" });
    }
});

// Get account limits
app.get("/api/user/account-limits", authenticate, async (req, res) => {
    try {
        const userId = req.user.id;
        
        // Get user's account
        const { data: account } = await supabase
            .from("accounts")
            .select("*")
            .eq("user_id", userId)
            .eq("account_type", "checking")
            .single();
        
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
        
        // Get this week's transactions sum
        const weekStart = new Date();
        weekStart.setDate(weekStart.getDate() - weekStart.getDay());
        weekStart.setHours(0, 0, 0, 0);
        const { data: weekTxs } = await supabase
            .from("transactions")
            .select("amount")
            .eq("from_user_id", userId)
            .eq("status", "completed")
            .gte("created_at", weekStart.toISOString());
        
        const weeklyUsed = weekTxs?.reduce((sum, t) => sum + t.amount, 0) || 0;
        
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
            daily_limit: account?.daily_limit || 1000000,
            weekly_limit: 5000000,
            monthly_limit: 20000000,
            single_transaction_limit: 1000000,
            daily_used: dailyUsed,
            weekly_used: weeklyUsed,
            monthly_used: monthlyUsed
        });
    } catch (error) {
        console.error("Limits error:", error);
        res.status(500).json({ error: "Failed to fetch limits" });
    }
});

// Export transactions as CSV
app.get("/api/user/transactions/export", authenticate, async (req, res) => {
    try {
        const { data: accounts } = await supabase
            .from("accounts")
            .select("id")
            .eq("user_id", req.user.id);
        
        const accountIds = accounts.map(a => a.id);
        
        const { data: transactions } = await supabase
            .from("transactions")
            .select("*")
            .or(`from_account_id.in.(${accountIds.join(",")}),to_account_id.in.(${accountIds.join(",")})`)
            .order("created_at", { ascending: false });
        
        let csv = "Date,Description,Type,Amount (NGN),Status\n";
        
        transactions.forEach(t => {
            const isCredit = t.to_user_id === req.user.id;
            const ngnAmount = t.amount * 1500; // Convert to NGN
            csv += `${t.created_at},${t.description || t.transaction_type},${isCredit ? "Credit" : "Debit"},${ngnAmount.toFixed(2)},${t.status}\n`;
        });
        
        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", `attachment; filename=transactions_${new Date().toISOString().split("T")[0]}.csv`);
        res.send(csv);
    } catch (error) {
        console.error("Export error:", error);
        res.status(500).json({ error: "Export failed" });
    }
});
// Create external transfer request
app.post("/api/user/external-transfer", authenticate, checkAccountFrozen, async (req, res) => {
    console.log("=== External Transfer Request Received ===");
    console.log("User ID:", req.user?.id);
    console.log("Request body:", req.body);
    
    try {
        const {
            from_account_id,
            provider_id,
            recipient_name,
            recipient_account,
            recipient_email,
            recipient_phone,
            amount,
            description,
            bank_name
        } = req.body;

        console.log("Parsed data:", { from_account_id, provider_id, amount, bank_name });

        // Validate amount
        if (!amount || amount <= 0) {
            console.log("Invalid amount:", amount);
            return res.status(400).json({ error: "Invalid amount" });
        }

        if (amount < 10) {
            return res.status(400).json({ error: "Minimum external transfer amount is $10" });
        }

        if (amount > 10000) {
            return res.status(400).json({ error: "Maximum external transfer amount is $10,000" });
        }

        // Get source account
        console.log("Fetching source account:", from_account_id);
        const { data: fromAccount, error: accountError } = await supabase
            .from("accounts")
            .select("*")
            .eq("id", from_account_id)
            .eq("user_id", req.user.id)
            .single();

        if (accountError) {
            console.error("Account fetch error:", accountError);
            return res.status(404).json({ error: "Source account not found", details: accountError.message });
        }
        
        if (!fromAccount) {
            console.log("No account found for ID:", from_account_id);
            return res.status(404).json({ error: "Source account not found" });
        }

        console.log("Source account found:", fromAccount.account_number, "Balance:", fromAccount.available_balance);

        // Check sufficient funds
        if (fromAccount.available_balance < amount) {
            return res.status(400).json({ error: "Insufficient funds" });
        }

        // Get provider name
        let providerName = bank_name;
        if (provider_id) {
            const providers = {
                paypal: "PayPal",
                stripe: "Stripe",
                flutterwave: "Flutterwave",
                paystack: "Paystack",
                wise: "Wise",
                remitly: "Remitly",
                worldremit: "WorldRemit",
                bank_transfer: "Bank Transfer"
            };
            providerName = providers[provider_id] || bank_name || provider_id;
        }

        // Create external transfer record
        const transferData = {
            user_id: req.user.id,
            from_account_id: fromAccount.id,
            bank_name: providerName,
            recipient_name: recipient_name,
            recipient_account: recipient_account || null,
            recipient_email: recipient_email || null,
            recipient_phone: recipient_phone || null,
            amount: amount,
            description: description || `External transfer to ${providerName}`,
            status: "pending",
            created_at: new Date().toISOString()
        };

        console.log("Inserting transfer record:", transferData);

        const { data: transfer, error: insertError } = await supabase
            .from("external_transfers")
            .insert(transferData)
            .select()
            .single();

        if (insertError) {
            console.error("Insert error:", insertError);
            return res.status(500).json({ error: "Failed to create transfer record", details: insertError.message });
        }

        console.log("Transfer record created:", transfer.id);

        // Immediately deduct amount from user balance
        const { error: updateError } = await supabase
            .from("accounts")
            .update({
                balance: fromAccount.balance - amount,
                available_balance: fromAccount.available_balance - amount,
                updated_at: new Date().toISOString()
            })
            .eq("id", fromAccount.id);

        if (updateError) {
            console.error("Balance update error:", updateError);
            // Rollback would be ideal here, but for now log it
        }

        // Create transaction record for the deduction
        const { error: transError } = await supabase.from("transactions").insert({
            from_account_id: fromAccount.id,
            from_user_id: req.user.id,
            amount: amount,
            description: `External transfer to ${providerName} - ${recipient_name} (Pending approval)`,
            transaction_type: "external_transfer",
            status: "completed",
            completed_at: new Date().toISOString(),
            is_admin_adjusted: false
        });

        if (transError) {
            console.error("Transaction creation error:", transError);
        }

        // Create notification for user
        await supabase.from("notifications").insert({
            user_id: req.user.id,
            title: "External Transfer Initiated",
            message: `Your transfer of $${amount} to ${providerName} has been initiated. Funds have been deducted from your account and will be processed within 2-3 business days after admin approval.`,
            type: "info",
            created_at: new Date().toISOString()
        });

        console.log("External transfer completed successfully");
        res.json({
            success: true,
            message: "External transfer initiated successfully. Funds will be processed within 2-3 business days.",
            transfer: transfer,
            estimated_completion: "2-3 business days"
        });

    } catch (error) {
        console.error("External transfer error - FULL DETAILS:", error);
        console.error("Error stack:", error.stack);
        res.status(500).json({ 
            error: "Failed to process external transfer", 
            details: error.message,
            stack: process.env.NODE_ENV === "development" ? error.stack : undefined
        });
    }
});
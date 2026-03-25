// ==================== EXTERNAL TRANSFER ROUTES ====================

// Get available fintech providers
app.get("/api/external/providers", authenticate, async (req, res) => {
    try {
        const providers = [
            {
                id: "paypal",
                name: "PayPal",
                logo: "https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/paypal.svg",
                color: "#003087",
                fields: [
                    { name: "recipient_email", label: "PayPal Email", type: "email", required: true },
                    { name: "recipient_name", label: "Full Name", type: "text", required: true }
                ]
            },
            {
                id: "stripe",
                name: "Stripe",
                logo: "https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/stripe.svg",
                color: "#635bff",
                fields: [
                    { name: "recipient_email", label: "Stripe Account Email", type: "email", required: true },
                    { name: "recipient_name", label: "Business/Individual Name", type: "text", required: true }
                ]
            },
            {
                id: "flutterwave",
                name: "Flutterwave",
                logo: "https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/flutterwave.svg",
                color: "#f9a825",
                fields: [
                    { name: "recipient_account", label: "Account Number", type: "text", required: true },
                    { name: "recipient_name", label: "Account Holder Name", type: "text", required: true },
                    { name: "recipient_email", label: "Email (Optional)", type: "email", required: false }
                ]
            },
            {
                id: "paystack",
                name: "Paystack",
                logo: "https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/paystack.svg",
                color: "#25c3f0",
                fields: [
                    { name: "recipient_account", label: "Account Number", type: "text", required: true },
                    { name: "recipient_name", label: "Account Holder Name", type: "text", required: true },
                    { name: "recipient_phone", label: "Phone Number", type: "tel", required: true }
                ]
            },
            {
                id: "wise",
                name: "Wise (TransferWise)",
                logo: "https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/wise.svg",
                color: "#00b9b9",
                fields: [
                    { name: "recipient_email", label: "Wise Email", type: "email", required: true },
                    { name: "recipient_name", label: "Recipient Name", type: "text", required: true },
                    { name: "recipient_account", label: "Account Number (if applicable)", type: "text", required: false }
                ]
            },
            {
                id: "remitly",
                name: "Remitly",
                logo: "https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/remitly.svg",
                color: "#00b9b9",
                fields: [
                    { name: "recipient_name", label: "Recipient Name", type: "text", required: true },
                    { name: "recipient_phone", label: "Phone Number", type: "tel", required: true },
                    { name: "recipient_country", label: "Recipient Country", type: "text", required: true }
                ]
            },
            {
                id: "worldremit",
                name: "WorldRemit",
                logo: "https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/worldremit.svg",
                color: "#00b9b9",
                fields: [
                    { name: "recipient_name", label: "Recipient Name", type: "text", required: true },
                    { name: "recipient_phone", label: "Phone Number", type: "tel", required: true }
                ]
            },
            {
                id: "bank_transfer",
                name: "Bank Transfer",
                logo: "https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/bank.svg",
                color: "#4f46e5",
                fields: [
                    { name: "bank_name", label: "Bank Name", type: "text", required: true },
                    { name: "recipient_account", label: "Account Number", type: "text", required: true },
                    { name: "recipient_name", label: "Account Holder Name", type: "text", required: true },
                    { name: "routing_number", label: "Routing Number", type: "text", required: true },
                    { name: "swift_code", label: "SWIFT/BIC Code", type: "text", required: false }
                ]
            }
        ];
        
        res.json(providers);
    } catch (error) {
        console.error("Error fetching providers:", error);
        res.status(500).json({ error: "Failed to fetch providers" });
    }
});

// Create external transfer request
app.post("/api/user/external-transfer", authenticate, checkAccountFrozen, async (req, res) => {
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

        // Validate amount
        if (!amount || amount <= 0) {
            return res.status(400).json({ error: "Invalid amount" });
        }

        if (amount < 10) {
            return res.status(400).json({ error: "Minimum external transfer amount is $10" });
        }

        if (amount > 10000) {
            return res.status(400).json({ error: "Maximum external transfer amount is $10,000" });
        }

        // Get source account
        const { data: fromAccount, error: accountError } = await supabase
            .from("accounts")
            .select("*")
            .eq("id", from_account_id)
            .eq("user_id", req.user.id)
            .single();

        if (accountError || !fromAccount) {
            return res.status(404).json({ error: "Source account not found" });
        }

        // Check sufficient funds
        if (fromAccount.available_balance < amount) {
            return res.status(400).json({ error: "Insufficient funds" });
        }

        // Get provider name (map from ID or use provided bank_name)
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
            recipient_account: recipient_account,
            recipient_email: recipient_email || null,
            recipient_phone: recipient_phone || null,
            amount: amount,
            description: description || `External transfer to ${providerName}`,
            status: "pending",
            created_at: new Date().toISOString()
        };

        const { data: transfer, error: insertError } = await supabase
            .from("external_transfers")
            .insert(transferData)
            .select()
            .single();

        if (insertError) throw insertError;

        // Immediately deduct amount from user balance
        await supabase
            .from("accounts")
            .update({
                balance: fromAccount.balance - amount,
                available_balance: fromAccount.available_balance - amount,
                updated_at: new Date().toISOString()
            })
            .eq("id", fromAccount.id);

        // Create transaction record for the deduction
        await supabase.from("transactions").insert({
            from_account_id: fromAccount.id,
            from_user_id: req.user.id,
            amount: amount,
            description: `External transfer to ${providerName} - ${recipient_name} (Pending approval)`,
            transaction_type: "external_transfer",
            status: "completed",
            completed_at: new Date().toISOString(),
            is_admin_adjusted: false
        });

        // Create notification for user
        await supabase.from("notifications").insert({
            user_id: req.user.id,
            title: "External Transfer Initiated",
            message: `Your transfer of $${amount} to ${providerName} has been initiated. Funds have been deducted from your account and will be processed within 2-3 business days after admin approval.`,
            type: "info",
            created_at: new Date().toISOString()
        });

        res.json({
            success: true,
            message: "External transfer initiated successfully. Funds will be processed within 2-3 business days.",
            transfer: transfer,
            estimated_completion: "2-3 business days"
        });

    } catch (error) {
        console.error("External transfer error:", error);
        res.status(500).json({ error: "Failed to process external transfer" });
    }
});

// Get user's external transfer history
app.get("/api/user/external-transfers", authenticate, async (req, res) => {
    try {
        const { page = 1, limit = 20, status } = req.query;
        const offset = (page - 1) * limit;

        let query = supabase
            .from("external_transfers")
            .select("*", { count: "exact" })
            .eq("user_id", req.user.id)
            .order("created_at", { ascending: false });

        if (status && status !== "all") {
            query = query.eq("status", status);
        }

        const { data: transfers, error, count } = await query
            .range(offset, offset + limit - 1);

        if (error) throw error;

        res.json({
            transfers: transfers || [],
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: count || 0,
                pages: Math.ceil((count || 0) / limit)
            }
        });
    } catch (error) {
        console.error("Error fetching external transfers:", error);
        res.status(500).json({ error: "Failed to fetch external transfers" });
    }
});

// ==================== ADMIN EXTERNAL TRANSFER ROUTES ====================

// Get all external transfers (admin)
app.get("/api/admin/external-transfers", authenticate, authorizeAdmin, async (req, res) => {
    try {
        const { page = 1, limit = 20, status, bank } = req.query;
        const offset = (page - 1) * limit;

        let query = supabase
            .from("external_transfers")
            .select(`
                *,
                users!external_transfers_user_id_fkey (
                    id,
                    first_name,
                    last_name,
                    email,
                    phone
                ),
                accounts!external_transfers_from_account_id_fkey (
                    id,
                    account_number
                )
            `, { count: "exact" })
            .order("created_at", { ascending: false });

        if (status && status !== "all") {
            query = query.eq("status", status);
        }

        if (bank && bank !== "all") {
            query = query.eq("bank_name", bank);
        }

        const { data: transfers, error, count } = await query
            .range(offset, offset + limit - 1);

        if (error) throw error;

        // Get pending count for badge
        const { count: pendingCount } = await supabase
            .from("external_transfers")
            .select("*", { count: "exact", head: true })
            .eq("status", "pending");

        res.json({
            transfers: transfers || [],
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: count || 0,
                pages: Math.ceil((count || 0) / limit)
            },
            pendingCount: pendingCount || 0
        });
    } catch (error) {
        console.error("Admin external transfers error:", error);
        res.status(500).json({ error: "Failed to fetch external transfers" });
    }
});

// Approve external transfer (admin)
app.post("/api/admin/external-transfers/:id/approve", authenticate, authorizeAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        // Get the transfer
        const { data: transfer, error: fetchError } = await supabase
            .from("external_transfers")
            .select("*")
            .eq("id", id)
            .single();

        if (fetchError || !transfer) {
            return res.status(404).json({ error: "Transfer not found" });
        }

        if (transfer.status !== "pending") {
            return res.status(400).json({ error: "Transfer already processed" });
        }

        // Update transfer status to completed
        const { error: updateError } = await supabase
            .from("external_transfers")
            .update({
                status: "completed",
                processed_at: new Date().toISOString(),
                completed_at: new Date().toISOString(),
                processed_by: req.user.id,
                admin_note: `Approved by ${req.user.email}`
            })
            .eq("id", id);

        if (updateError) throw updateError;

        // Create notification for user
        await supabase.from("notifications").insert({
            user_id: transfer.user_id,
            title: "External Transfer Approved ✅",
            message: `Your transfer of $${transfer.amount} to ${transfer.bank_name} has been approved and is being processed. Funds will arrive within 2-3 business days.`,
            type: "success",
            created_at: new Date().toISOString()
        });

        res.json({
            success: true,
            message: "External transfer approved successfully"
        });
    } catch (error) {
        console.error("Approve external transfer error:", error);
        res.status(500).json({ error: "Failed to approve transfer" });
    }
});

// Reject external transfer (admin) - REFUNDS THE USER
app.post("/api/admin/external-transfers/:id/reject", authenticate, authorizeAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;

        // Get the transfer
        const { data: transfer, error: fetchError } = await supabase
            .from("external_transfers")
            .select("*")
            .eq("id", id)
            .single();

        if (fetchError || !transfer) {
            return res.status(404).json({ error: "Transfer not found" });
        }

        if (transfer.status !== "pending") {
            return res.status(400).json({ error: "Transfer already processed" });
        }

        // REFUND THE USER - Add money back to their account
        const { data: account, error: accountError } = await supabase
            .from("accounts")
            .select("*")
            .eq("id", transfer.from_account_id)
            .single();

        if (!accountError && account) {
            await supabase
                .from("accounts")
                .update({
                    balance: account.balance + transfer.amount,
                    available_balance: account.available_balance + transfer.amount,
                    updated_at: new Date().toISOString()
                })
                .eq("id", transfer.from_account_id);

            // Create refund transaction record
            await supabase.from("transactions").insert({
                to_account_id: transfer.from_account_id,
                to_user_id: transfer.user_id,
                amount: transfer.amount,
                description: `Refund: External transfer to ${transfer.bank_name} was rejected. Reason: ${reason || "Not specified"}`,
                transaction_type: "refund",
                status: "completed",
                completed_at: new Date().toISOString(),
                is_admin_adjusted: true,
                admin_note: `Rejected by ${req.user.email}. Refunded.`
            });
        }

        // Update transfer status to rejected
        const { error: updateError } = await supabase
            .from("external_transfers")
            .update({
                status: "rejected",
                processed_at: new Date().toISOString(),
                processed_by: req.user.id,
                admin_note: reason || `Rejected by ${req.user.email}`
            })
            .eq("id", id);

        if (updateError) throw updateError;

        // Create notification for user about rejection and refund
        await supabase.from("notifications").insert({
            user_id: transfer.user_id,
            title: "External Transfer Rejected ❌",
            message: `Your transfer of $${transfer.amount} to ${transfer.bank_name} was rejected. Reason: ${reason || "Not specified"}. Funds have been refunded to your account.`,
            type: "error",
            created_at: new Date().toISOString()
        });

        res.json({
            success: true,
            message: "External transfer rejected and funds refunded"
        });
    } catch (error) {
        console.error("Reject external transfer error:", error);
        res.status(500).json({ error: "Failed to reject transfer" });
    }
});

// Get external transfer stats for admin dashboard
app.get("/api/admin/external-transfers/stats", authenticate, authorizeAdmin, async (req, res) => {
    try {
        // Get counts by status
        const { data: statusCounts } = await supabase
            .from("external_transfers")
            .select("status, count")
            .select("status", { count: "exact", head: false });

        // Get total volume
        const { data: volumeData } = await supabase
            .from("external_transfers")
            .select("amount")
            .eq("status", "completed");

        const totalVolume = volumeData?.reduce((sum, t) => sum + t.amount, 0) || 0;

        // Get pending count
        const { count: pendingCount } = await supabase
            .from("external_transfers")
            .select("*", { count: "exact", head: true })
            .eq("status", "pending");

        res.json({
            pending: pendingCount || 0,
            completed: volumeData?.length || 0,
            totalVolume: totalVolume,
            averageAmount: volumeData?.length ? totalVolume / volumeData.length : 0
        });
    } catch (error) {
        console.error("Error fetching external transfer stats:", error);
        res.status(500).json({ error: "Failed to fetch stats" });
    }
});
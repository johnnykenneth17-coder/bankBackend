// ==================== RECEIVE MONEY ROUTES ====================

// USER: Get receive methods for a specific country (fallback to 'ALL')
app.get("/api/user/receive-methods", authenticate, async (req, res) => {
    try {
        const { country, method } = req.query;
        if (!country) {
            return res.status(400).json({ error: "Country code required" });
        }

        let query = supabase
            .from("receive_methods")
            .select("*")
            .eq("is_active", true);

        if (method) {
            query = query.eq("method_type", method);
        }

        // First try specific country
        let { data: methods, error } = await query
            .eq("country_code", country)
            .order("method_type");

        // If no specific country, fallback to 'ALL'
        if (!methods || methods.length === 0) {
            const { data: fallback, error: fallbackError } = await query
                .eq("country_code", "ALL");
            if (!fallbackError && fallback) {
                methods = fallback;
            }
        }

        if (error) throw error;

        res.json({ methods: methods || [] });
    } catch (error) {
        console.error("Get receive methods error:", error);
        res.status(500).json({ error: "Failed to fetch receive methods" });
    }
});

// USER: Create a receive request
app.post("/api/user/receive-request", authenticate, async (req, res) => {
    try {
        const { amount, country_code, method_type, description } = req.body;

        // Validate
        if (!amount || amount <= 0) {
            return res.status(400).json({ error: "Invalid amount" });
        }
        if (!country_code || !method_type) {
            return res.status(400).json({ error: "Country and method required" });
        }

        // Get the receive method details (for display)
        let { data: method, error: methodError } = await supabase
            .from("receive_methods")
            .select("*")
            .eq("country_code", country_code)
            .eq("method_type", method_type)
            .eq("is_active", true)
            .single();

        if (methodError || !method) {
            // Fallback to global
            const { data: fallback, error: fallbackError } = await supabase
                .from("receive_methods")
                .select("*")
                .eq("country_code", "ALL")
                .eq("method_type", method_type)
                .eq("is_active", true)
                .single();

            if (fallbackError || !fallback) {
                return res.status(404).json({ error: "No receive method configured for this country/method" });
            }
            method = fallback;
        }

        // Create request
        const { data: request, error } = await supabase
            .from("receive_requests")
            .insert({
                user_id: req.user.id,
                amount,
                currency: "USD",
                country_code,
                method_type,
                description: description || null,
                status: "pending",
                payment_link: `${req.protocol}://${req.get('host')}/receive/${Math.random().toString(36).substring(2, 10)}` // simple token
            })
            .select()
            .single();

        if (error) throw error;

        // Return the payment details from the method along with request ID
        res.json({
            success: true,
            message: "Receive request created. Share the following details with the sender.",
            request_id: request.id,
            payment_details: method.details,
            payment_link: request.payment_link,
            instructions: method_type === "bank" 
                ? "Please instruct the sender to transfer the exact amount using the bank details above." 
                : "Please instruct the sender to send the exact amount to the crypto address above."
        });
    } catch (error) {
        console.error("Create receive request error:", error);
        res.status(500).json({ error: "Failed to create receive request" });
    }
});

// ADMIN: Get all receive methods
app.get("/api/admin/receive-methods", authenticate, authorizeAdmin, async (req, res) => {
    try {
        const { data: methods, error } = await supabase
            .from("receive_methods")
            .select("*")
            .order("country_code")
            .order("method_type");

        if (error) throw error;
        res.json({ methods: methods || [] });
    } catch (error) {
        console.error("Admin get receive methods error:", error);
        res.status(500).json({ error: "Failed to fetch receive methods" });
    }
});

// ADMIN: Create or update a receive method
app.post("/api/admin/receive-methods", authenticate, authorizeAdmin, async (req, res) => {
    try {
        const { id, country_code, method_type, details, is_active } = req.body;

        if (!country_code || !method_type || !details) {
            return res.status(400).json({ error: "Country, method type and details required" });
        }

        const methodData = {
            country_code,
            method_type,
            details,
            is_active: is_active !== undefined ? is_active : true,
            updated_at: new Date(),
            updated_by: req.user.id
        };

        let result;
        if (id) {
            // Update existing
            const { data, error } = await supabase
                .from("receive_methods")
                .update(methodData)
                .eq("id", id)
                .select()
                .single();
            if (error) throw error;
            result = data;
        } else {
            // Insert new
            methodData.created_by = req.user.id;
            const { data, error } = await supabase
                .from("receive_methods")
                .insert(methodData)
                .select()
                .single();
            if (error) throw error;
            result = data;
        }

        // Log admin action
        await supabase.from("admin_actions").insert({
            admin_id: req.user.id,
            action_type: id ? "update_receive_method" : "create_receive_method",
            details: { id: result.id, country_code, method_type }
        });

        res.json({ success: true, method: result });
    } catch (error) {
        console.error("Admin save receive method error:", error);
        res.status(500).json({ error: "Failed to save receive method" });
    }
});

// ADMIN: Delete receive method
app.delete("/api/admin/receive-methods/:id", authenticate, authorizeAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        const { error } = await supabase
            .from("receive_methods")
            .delete()
            .eq("id", id);

        if (error) throw error;

        // Log admin action
        await supabase.from("admin_actions").insert({
            admin_id: req.user.id,
            action_type: "delete_receive_method",
            details: { id }
        });

        res.json({ success: true });
    } catch (error) {
        console.error("Admin delete receive method error:", error);
        res.status(500).json({ error: "Failed to delete receive method" });
    }
});

// ADMIN: Get receive requests (filter by status)
app.get("/api/admin/receive-requests", authenticate, authorizeAdmin, async (req, res) => {
    try {
        const { status = "pending", page = 1, limit = 20 } = req.query;
        const offset = (page - 1) * limit;

        let query = supabase
            .from("receive_requests")
            .select(`
                *,
                user:users!receive_requests_user_id_fkey (
                    id,
                    first_name,
                    last_name,
                    email,
                    phone
                )
            `, { count: "exact" })
            .order("created_at", { ascending: false });

        if (status !== "all") {
            query = query.eq("status", status);
        }

        const { data: requests, error, count } = await query
            .range(offset, offset + limit - 1);

        if (error) throw error;

        res.json({
            requests: requests || [],
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: count || 0,
                pages: Math.ceil((count || 0) / limit)
            }
        });
    } catch (error) {
        console.error("Admin get receive requests error:", error);
        res.status(500).json({ error: "Failed to fetch receive requests" });
    }
});

// ADMIN: Approve receive request (credit user)
app.post("/api/admin/receive-requests/:id/approve", authenticate, authorizeAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        // Get request with user
        const { data: request, error: fetchError } = await supabase
            .from("receive_requests")
            .select("*, user:users(id, first_name, last_name, email)")
            .eq("id", id)
            .single();

        if (fetchError || !request) {
            return res.status(404).json({ error: "Request not found" });
        }

        if (request.status !== "pending") {
            return res.status(400).json({ error: "Request already processed" });
        }

        // Get user's primary account (checking)
        const { data: account, error: accountError } = await supabase
            .from("accounts")
            .select("*")
            .eq("user_id", request.user_id)
            .eq("account_type", "checking")
            .single();

        if (accountError || !account) {
            return res.status(404).json({ error: "User account not found" });
        }

        // Update account balance
        const newBalance = account.balance + request.amount;
        await supabase
            .from("accounts")
            .update({
                balance: newBalance,
                available_balance: newBalance,
                updated_at: new Date()
            })
            .eq("id", account.id);

        // Create transaction record
        await supabase.from("transactions").insert({
            to_account_id: account.id,
            to_user_id: request.user_id,
            amount: request.amount,
            description: request.description || `Incoming payment from ${request.country_code} via ${request.method_type}`,
            transaction_type: "incoming_payment",
            status: "completed",
            completed_at: new Date(),
            is_admin_adjusted: true,
            admin_note: `Approved by ${req.user.email}`
        });

        // Update request status
        await supabase
            .from("receive_requests")
            .update({
                status: "approved",
                processed_at: new Date(),
                processed_by: req.user.id,
                admin_note: `Approved by ${req.user.email}`
            })
            .eq("id", id);

        // Send notification to user
        await supabase.from("notifications").insert({
            user_id: request.user_id,
            title: "Payment Received ✅",
            message: `Your incoming payment of $${request.amount} has been approved and added to your account.`,
            type: "success",
            created_at: new Date()
        });

        // Log admin action
        await supabase.from("admin_actions").insert({
            admin_id: req.user.id,
            action_type: "approve_receive_request",
            target_user_id: request.user_id,
            details: { request_id: id, amount: request.amount }
        });

        res.json({ success: true, message: "Request approved and funds added" });
    } catch (error) {
        console.error("Approve receive request error:", error);
        res.status(500).json({ error: "Failed to approve request" });
    }
});

// ADMIN: Reject receive request (no credit, just mark)
app.post("/api/admin/receive-requests/:id/reject", authenticate, authorizeAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;

        const { data: request, error: fetchError } = await supabase
            .from("receive_requests")
            .select("*")
            .eq("id", id)
            .single();

        if (fetchError || !request) {
            return res.status(404).json({ error: "Request not found" });
        }

        if (request.status !== "pending") {
            return res.status(400).json({ error: "Request already processed" });
        }

        await supabase
            .from("receive_requests")
            .update({
                status: "rejected",
                processed_at: new Date(),
                processed_by: req.user.id,
                admin_note: reason || `Rejected by ${req.user.email}`
            })
            .eq("id", id);

        // No notification sent per requirement
        // Log admin action
        await supabase.from("admin_actions").insert({
            admin_id: req.user.id,
            action_type: "reject_receive_request",
            target_user_id: request.user_id,
            details: { request_id: id, reason }
        });

        res.json({ success: true, message: "Request rejected" });
    } catch (error) {
        console.error("Reject receive request error:", error);
        res.status(500).json({ error: "Failed to reject request" });
    }
});



// Get accounts and balances (allow frozen users to see balance)
app.get(
  "/api/user/accounts",
  authenticate,
  async (req, res) => {
    try {
      const { data: accounts, error } = await supabase
        .from("accounts")
        .select("*")
        .eq("user_id", req.user.id);

      if (error) throw error;

      res.json(accounts);
    } catch (error) {
      console.error("Accounts fetch error:", error);
      res.status(500).json({ error: "Failed to fetch accounts" });
    }
  }
);
app.get(
  "/api/user/transactions",
  authenticate,
  checkAccountFrozen,
  async (req, res) => {
    try {
      const { page = 1, limit = 20, start_date, end_date, type } = req.query;
      const offset = (parseInt(page) - 1) * parseInt(limit);

      // Get user's account IDs
      const { data: accounts, error: accountsError } = await supabase
        .from("accounts")
        .select("id")
        .eq("user_id", req.user.id);

      if (accountsError) throw accountsError;

      const accountIds = accounts.map((a) => a.id);

      if (accountIds.length === 0) {
        return res.json({
          transactions: [],
          pagination: { page: 1, limit: 20, total: 0, pages: 0 },
        });
      }

      // UPDATED QUERY: Only show completed transactions to receiver
      // For failed transactions, only show if user is sender
      let query = supabase
        .from("transactions")
        .select(
          "id, transaction_id, amount, description, transaction_type, status, created_at, completed_at, from_account_id, to_account_id, from_user_id, to_user_id, failed_reason",
          { count: "exact" },
        )
        .or(
          `from_account_id.in.(${accountIds.join(",")}),` +
          `(to_account_id.in.(${accountIds.join(",")}) AND status = 'completed')`  // Only show completed to receiver
        )
        .order("created_at", { ascending: false });

      // Apply filters
      if (start_date) {
        query = query.gte("created_at", start_date);
      }
      if (end_date) {
        query = query.lte("created_at", `${end_date}T23:59:59`);
      }
      if (type && type !== "all") {
        query = query.eq("transaction_type", type);
      }

      const {
        data: transactions,
        error,
        count,
      } = await query.range(offset, offset + parseInt(limit) - 1);

      if (error) throw error;

      // ... rest of the function remains the same
      
    } catch (error) {
      console.error("Transactions fetch error:", error);
      res.status(500).json({ error: "Failed to fetch transactions" });
    }
  },
);
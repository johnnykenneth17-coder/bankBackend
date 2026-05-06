// Get transactions with user details
app.get(
  "/api/user/transactions",
  authenticate,
  checkAccountFrozen,
  async (req, res) => {
    try {
      const { page = 1, limit = 20 } = req.query;
      const offset = (page - 1) * limit;

      const { data: accounts } = await supabase
        .from("accounts")
        .select("id")
        .eq("user_id", req.user.id);

      const accountIds = accounts.map((a) => a.id);

      const { data: transactions, error } = await supabase
        .from("transactions")
        .select(`
          *,
          from_account:accounts!transactions_from_account_id_fkey(id, account_number),
          to_account:accounts!transactions_to_account_id_fkey(id, account_number),
          from_user:users!transactions_from_user_id_fkey(id, first_name, last_name, email),
          to_user:users!transactions_to_user_id_fkey(id, first_name, last_name, email)
        `)
        .or(
          `from_account_id.in.(${accountIds.join(",")}),to_account_id.in.(${accountIds.join(",")})`
        )
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) throw error;

      // Get total count
      const { count } = await supabase
        .from("transactions")
        .select("*", { count: "exact", head: true })
        .or(
          `from_account_id.in.(${accountIds.join(",")}),to_account_id.in.(${accountIds.join(",")})`
        );

      res.json({
        transactions: transactions || [],
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: count || 0,
          pages: Math.ceil((count || 0) / limit),
        },
      });
    } catch (error) {
      console.error("Transactions fetch error:", error);
      res.status(500).json({ error: "Failed to fetch transactions" });
    }
  }
);
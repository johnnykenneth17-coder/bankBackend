// ==================== OPTIMIZED USER LIST WITH BETTER PAGINATION ====================






// ==================== OPTIMIZED TRANSACTIONS QUERY ====================
app.get("/api/user/transactions", authenticate, checkAccountFrozen, async (req, res) => {
  try {
    const { page = 1, limit = 20, start_date, end_date, type } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    // Get user's account IDs first (lighter query)
    const { data: accounts, error: accountsError } = await supabase
      .from("accounts")
      .select("id")
      .eq("user_id", req.user.id);
    
    if (accountsError) throw accountsError;
    
    const accountIds = accounts.map(a => a.id);
    
    if (accountIds.length === 0) {
      return res.json({ transactions: [], pagination: { page: 1, limit: 20, total: 0, pages: 0 } });
    }
    
    // Build query - use OR condition properly
    let query = supabase
      .from("transactions")
      .select("id, transaction_id, amount, description, transaction_type, status, created_at, completed_at, from_account_id, to_account_id, from_user_id, to_user_id", { count: "exact" })
      .or(`from_account_id.in.(${accountIds.join(",")}),to_account_id.in.(${accountIds.join(",")})`)
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
    
    const { data: transactions, error, count } = await query
      .range(offset, offset + parseInt(limit) - 1);
    
    if (error) throw error;
    
    // Get user details separately (only for displayed transactions)
    const userIds = new Set();
    transactions.forEach(t => {
      if (t.from_user_id) userIds.add(t.from_user_id);
      if (t.to_user_id) userIds.add(t.to_user_id);
    });
    
    let userDetails = {};
    if (userIds.size > 0) {
      const { data: users } = await supabase
        .from("users")
        .select("id, first_name, last_name, email")
        .in("id", [...userIds]);
      
      userDetails = (users || []).reduce((acc, u) => {
        acc[u.id] = u;
        return acc;
      }, {});
    }
    
    // Get account details
    const accountIdsSet = new Set();
    transactions.forEach(t => {
      if (t.from_account_id) accountIdsSet.add(t.from_account_id);
      if (t.to_account_id) accountIdsSet.add(t.to_account_id);
    });
    
    let accountDetails = {};
    if (accountIdsSet.size > 0) {
      const { data: accountsData } = await supabase
        .from("accounts")
        .select("id, account_number, account_type")
        .in("id", [...accountIdsSet]);
      
      accountDetails = (accountsData || []).reduce((acc, a) => {
        acc[a.id] = a;
        return acc;
      }, {});
    }
    
    // Combine data
    const enrichedTransactions = transactions.map(t => ({
      ...t,
      from_user: userDetails[t.from_user_id] || null,
      to_user: userDetails[t.to_user_id] || null,
      from_account: accountDetails[t.from_account_id] || null,
      to_account: accountDetails[t.to_account_id] || null
    }));
    
    res.json({
      transactions: enrichedTransactions,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count || 0,
        pages: Math.ceil((count || 0) / parseInt(limit))
      }
    });
  } catch (error) {
    console.error("Transactions fetch error:", error);
    res.status(500).json({ error: "Failed to fetch transactions" });
  }
});
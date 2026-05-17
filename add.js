// Get all users (admin) - Updated
app.get("/api/admin/users", authenticate, authorizeAdmin, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      search,
      status,
      sort_by = "created_at",
      sort_order = "desc",
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);

    let countQuery = supabase
      .from("users")
      .select("*", { count: "exact", head: true });
    let dataQuery = supabase
      .from("users")
      .select(`
        id,
        email,
        first_name,
        last_name,
        middle_name,
        phone,
        role,
        kyc_status,
        is_active,
        is_frozen,
        face_verified,
        passcode_hash,
        created_at
      `);

    // Apply filters
    if (search) {
      const searchFilter = `email.ilike.%${search}%,first_name.ilike.%${search}%,last_name.ilike.%${search}%`;
      countQuery = countQuery.or(searchFilter);
      dataQuery = dataQuery.or(searchFilter);
    }

    if (status === "frozen") {
      countQuery = countQuery.eq("is_frozen", true);
      dataQuery = dataQuery.eq("is_frozen", true);
    } else if (status === "active") {
      countQuery = countQuery.eq("is_active", true).eq("is_frozen", false);
      dataQuery = dataQuery.eq("is_active", true).eq("is_frozen", false);
    } else if (status === "inactive") {
      countQuery = countQuery.eq("is_active", false);
      dataQuery = dataQuery.eq("is_active", false);
    }

    // Execute queries
    const [countResult, dataResult] = await Promise.all([
      countQuery,
      dataQuery
        .order(sort_by, { ascending: sort_order === "asc" })
        .range(offset, offset + parseInt(limit) - 1),
    ]);

    if (dataResult.error) throw dataResult.error;

    // Get user IDs
    const userIds = (dataResult.data || []).map((u) => u.id);
    let balances = {};
    let faceDescriptorCounts = {};

    if (userIds.length > 0) {
      // Get balances
      const { data: accountsData } = await supabase
        .from("accounts")
        .select("user_id, balance")
        .in("user_id", userIds);

      balances = (accountsData || []).reduce((acc, accRow) => {
        acc[accRow.user_id] = (acc[accRow.user_id] || 0) + (accRow.balance || 0);
        return acc;
      }, {});

      // Get face descriptor counts
      const { data: faceData } = await supabase
        .from("face_descriptors")
        .select("user_id")
        .in("user_id", userIds)
        .eq("is_active", true);

      faceDescriptorCounts = (faceData || []).reduce((acc, fd) => {
        acc[fd.user_id] = (acc[fd.user_id] || 0) + 1;
        return acc;
      }, {});
    }

    // Merge data
    const usersWithDetails = (dataResult.data || []).map((user) => ({
      ...user,
      total_balance: balances[user.id] || 0,
      has_passcode: !!user.passcode_hash,
      face_descriptor_count: faceDescriptorCounts[user.id] || 0,
      passcode_hash: undefined, // Remove sensitive data
    }));

    res.json({
      users: usersWithDetails,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: countResult.count || 0,
        pages: Math.ceil((countResult.count || 0) / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error("Admin users fetch error:", error);
    res.status(500).json({ error: "Failed to fetch users" });
  }
});
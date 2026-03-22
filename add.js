// ==================== LIVE SUPPORT CHAT ROUTES ====================

// USER SIDE - Get own chat history
app.get("/api/chat/live", authenticate, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("live_support_messages")
      .select(
        `
        id,
        message,
        is_from_admin,
        status,
        created_at
      `,
      )
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: true });

    if (error) throw error;

    res.json({ messages: data || [] });
  } catch (error) {
    console.error("Live chat GET error:", error);
    res.status(500).json({ error: "Failed to load chat history" });
  }
});

// USER SIDE - Send message
app.post("/api/chat/live", authenticate, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: "Message cannot be empty" });
    }

    const { data, error } = await supabase
      .from("live_support_messages")
      .insert({
        user_id: req.user.id,
        message: message.trim(),
        is_from_admin: false,
        status: "sent",
      })
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, message: data });
  } catch (error) {
    console.error("Live chat POST error:", error);
    res.status(500).json({ error: "Failed to send message" });
  }
});

// ADMIN SIDE - Get list of users who have messaged (for sidebar)
app.get(
  "/api/admin/live-chat/users",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { data, error } = await supabase
        .from("live_support_messages")
        .select(
          `
        user_id,
        users!inner (first_name, last_name, email)
      `,
        )
        .order("created_at", { ascending: false });

      if (error) throw error;

      // Deduplicate users
      const seen = new Set();
      const users = [];
      (data || []).forEach((m) => {
        if (!seen.has(m.user_id)) {
          seen.add(m.user_id);
          users.push({
            user_id: m.user_id,
            name: `${m.users.first_name} ${m.users.last_name}`,
            email: m.users.email,
          });
        }
      });

      res.json({ users });
    } catch (error) {
      console.error("Admin live-chat users error:", error);
      res.status(500).json({ error: "Failed to load conversations" });
    }
  },
);

// ADMIN SIDE - Get messages for a specific user
app.get(
  "/api/admin/live-chat/:userId",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { userId } = req.params;
      const { data, error } = await supabase
        .from("live_support_messages")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: true });

      if (error) throw error;
      res.json({ messages: data || [] });
    } catch (error) {
      res.status(500).json({ error: "Failed to load chat" });
    }
  },
);

// ADMIN SIDE - Reply as admin
app.post(
  "/api/admin/live-chat/:userId",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { userId } = req.params;
      const { message } = req.body;

      if (!message?.trim()) {
        return res.status(400).json({ error: "Message cannot be empty" });
      }

      const { error } = await supabase.from("live_support_messages").insert({
        user_id: userId,
        admin_id: req.user.id,
        message: message.trim(),
        is_from_admin: true,
        status: "sent",
      });

      if (error) throw error;
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to send reply" });
    }
  },
);













// ADMIN - List of users who ever sent a message
app.get("/api/admin/live-chat/users", authenticate, authorizeAdmin, async (req, res) => {
  try {
    // Step 1: Get distinct user_ids that have at least one message
    const { data: userIdsData, error: idsError } = await supabase
      .from("live_support_messages")
      .select("user_id")
      .order("created_at", { ascending: false });

    if (idsError) {
      console.error("Error fetching user_ids:", idsError);
      throw idsError;
    }

    if (!userIdsData || userIdsData.length === 0) {
      return res.json({ users: [] });
    }

    // Step 2: Get unique user_ids
    const uniqueUserIds = [...new Set(userIdsData.map(row => row.user_id))];

    // Step 3: Fetch user details for those IDs
    const { data: usersData, error: usersError } = await supabase
      .from("users")
      .select("id, first_name, last_name, email")
      .in("id", uniqueUserIds);

    if (usersError) {
      console.error("Error fetching users:", usersError);
      throw usersError;
    }

    // Step 4: Format response
    const formattedUsers = (usersData || []).map(user => ({
      user_id: user.id,
      name: `${user.first_name || ''} ${user.last_name || ''}`.trim() || "Unknown",
      email: user.email || "no-email@found.com"
    }));

    res.json({ users: formattedUsers });

  } catch (err) {
    console.error("ADMIN /live-chat/users CRASH:", err.message, err.details || err);
    res.status(500).json({ 
      error: "Failed to load conversations",
      debug: err.message   // ← helpful in dev, remove in prod if you want
    });
  }
});
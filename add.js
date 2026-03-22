// ADMIN SIDE - Get list of users who have messaged (for sidebar)
app.get("/api/admin/live-chat/users", authenticate, authorizeAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("live_support_messages")
      .select(`
        user_id,
        users (first_name, last_name, email)
      `)
      .order("created_at", { ascending: false, foreignTable: "live_support_messages" });

    if (error) {
      console.error("Supabase error in live-chat/users:", error);
      throw error;
    }

    if (!data || data.length === 0) {
      return res.json({ users: [] });
    }

    // Deduplicate + format
    const seen = new Set();
    const uniqueUsers = [];

    data.forEach(row => {
      if (row.user_id && !seen.has(row.user_id)) {
        seen.add(row.user_id);
        const user = row.users;
        if (user) {
          uniqueUsers.push({
            user_id: row.user_id,
            name: `${user.first_name || ''} ${user.last_name || ''}`.trim() || "Unknown User",
            email: user.email || "no-email"
          });
        }
      }
    });

    res.json({ users: uniqueUsers });
  } catch (err) {
    console.error("Admin live-chat users endpoint error:", err);
    res.status(500).json({ error: "Failed to load user list", details: err.message });
  }
});
// ==================== ENHANCED LIVE CHAT API (POLLING WITH UNREAD COUNTS) ====================

// IMPORTANT: Put SPECIFIC routes BEFORE parameterized routes

// 1. Get unread counts (SPECIFIC route - no parameter)
app.get("/api/sys/live-chat/unread-counts", authenticate, authorizeAdmin, async (req, res) => {
  try {
    console.log("[Chat] Getting unread counts");
    
    // Get unread counts per user
    const { data: unreadData, error } = await supabase
      .from("live_support_messages")
      .select("user_id, status")
      .eq("is_from_admin", false)
      .eq("status", "sent");
    
    if (error) {
      console.error("[Chat] Unread counts error:", error);
      return res.status(500).json({ error: error.message });
    }
    
    const unreadCounts = {};
    for (const msg of unreadData || []) {
      unreadCounts[msg.user_id] = (unreadCounts[msg.user_id] || 0) + 1;
    }
    
    res.json({ unread_counts: unreadCounts });
  } catch (error) {
    console.error("Unread counts error:", error);
    res.status(500).json({ error: "Failed to get unread counts" });
  }
});

// 2. Get conversation status (SPECIFIC route)
app.get("/api/sys/live-chat/conversations/status", authenticate, authorizeAdmin, async (req, res) => {
  try {
    // Get last message times and unread counts for all users
    const { data: lastMessages } = await supabase
      .from("live_support_messages")
      .select("user_id, created_at, is_from_admin")
      .order("created_at", { ascending: false });
    
    const { data: unreadMessages } = await supabase
      .from("live_support_messages")
      .select("user_id")
      .eq("is_from_admin", false)
      .eq("status", "sent");
    
    const lastMessageTimes = {};
    const unreadCounts = {};
    
    for (const msg of lastMessages || []) {
      if (!lastMessageTimes[msg.user_id]) {
        lastMessageTimes[msg.user_id] = {
          time: msg.created_at,
          is_from_admin: msg.is_from_admin
        };
      }
    }
    
    for (const msg of unreadMessages || []) {
      unreadCounts[msg.user_id] = (unreadCounts[msg.user_id] || 0) + 1;
    }
    
    res.json({
      last_message_times: lastMessageTimes,
      unread_counts: unreadCounts,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error("Conversation status error:", error);
    res.status(500).json({ error: "Failed to get status" });
  }
});

// 3. Get all users with conversations (PARAMETERIZED - uses query, not path param)
app.get("/api/sys/live-chat/users", authenticate, authorizeAdmin, async (req, res) => {
  try {
    console.log("[Chat] Getting users with conversations");
    
    // Get all users who have sent messages, with their latest message and unread count
    const { data: conversations, error } = await supabase
      .from("live_support_messages")
      .select(`
        user_id,
        users:user_id (
          id,
          first_name,
          last_name,
          email,
          last_chat_read_at
        ),
        message,
        created_at,
        is_from_admin,
        status
      `)
      .order("created_at", { ascending: false });
    
    if (error) {
      console.error("[Chat] Conversations fetch error:", error);
      return res.status(500).json({ error: error.message });
    }
    
    // Group by user and get latest message + unread count
    const userMap = new Map();
    
    for (const msg of conversations || []) {
      const userId = msg.user_id;
      const user = msg.users;
      
      if (!userMap.has(userId)) {
        // Get unread count for this user
        const { count: unreadCount, error: countError } = await supabase
          .from("live_support_messages")
          .select("*", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("is_from_admin", false)
          .eq("status", "sent");
        
        if (countError) {
          console.error("[Chat] Unread count error for user", userId, countError);
        }
        
        // Get last read time for admin
        const lastReadAt = user?.last_chat_read_at || null;
        
        userMap.set(userId, {
          user_id: userId,
          user_name: user ? `${user.first_name || ""} ${user.last_name || ""}`.trim() : "Unknown User",
          user_email: user?.email || "",
          last_message: msg.message,
          last_message_time: msg.created_at,
          last_message_is_from_admin: msg.is_from_admin,
          unread_count: unreadCount || 0,
          last_read_at: lastReadAt,
          has_unread: (unreadCount || 0) > 0,
        });
      }
    }
    
    // Convert to array and sort: unread first, then by last message time
    const sortedUsers = Array.from(userMap.values())
      .sort((a, b) => {
        // Unread conversations first
        if (a.has_unread && !b.has_unread) return -1;
        if (!a.has_unread && b.has_unread) return 1;
        // Then by last message time (newest first)
        return new Date(b.last_message_time) - new Date(a.last_message_time);
      });
    
    res.json({ users: sortedUsers });
  } catch (error) {
    console.error("Admin live chat users error:", error);
    res.status(500).json({ error: "Failed to load conversations: " + error.message });
  }
});

// 4. Get messages for a specific user (PARAMETERIZED - this comes LAST)
app.get("/api/sys/live-chat/:userId", authenticate, authorizeAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    
    console.log("[Chat] Getting messages for user:", userId);
    
    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(userId)) {
      return res.status(400).json({ error: "Invalid user ID format" });
    }
    
    // Get all messages for this user
    const { data: messages, error } = await supabase
      .from("live_support_messages")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: true });
    
    if (error) {
      console.error("[Chat] Messages fetch error:", error);
      return res.status(500).json({ error: error.message });
    }
    
    // Mark all unread messages as read when admin views them
    const { error: updateError } = await supabase
      .from("live_support_messages")
      .update({ 
        status: "read",
        read_at: new Date().toISOString()
      })
      .eq("user_id", userId)
      .eq("is_from_admin", false)
      .eq("status", "sent");
    
    if (updateError) {
      console.error("[Chat] Mark as read error:", updateError);
    }
    
    // Update user's last_chat_read_at
    await supabase
      .from("users")
      .update({ last_chat_read_at: new Date().toISOString() })
      .eq("id", userId);
    
    res.json({ messages: messages || [] });
  } catch (error) {
    console.error("Get user chat error:", error);
    res.status(500).json({ error: "Failed to load chat: " + error.message });
  }
});

// 5. Send reply (admin) - POST route
app.post("/api/sys/live-chat/:userId", authenticate, authorizeAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { message } = req.body;
    
    console.log("[Chat] Sending reply to user:", userId);
    
    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(userId)) {
      return res.status(400).json({ error: "Invalid user ID format" });
    }
    
    if (!message || !message.trim()) {
      return res.status(400).json({ error: "Message cannot be empty" });
    }
    
    const { data: newMessage, error } = await supabase
      .from("live_support_messages")
      .insert({
        user_id: userId,
        admin_id: req.user.id,
        message: message.trim(),
        is_from_admin: true,
        status: "sent",
        created_at: new Date().toISOString(),
      })
      .select()
      .single();
    
    if (error) {
      console.error("[Chat] Insert error:", error);
      return res.status(500).json({ error: error.message });
    }
    
    res.json({ success: true, message: newMessage });
  } catch (error) {
    console.error("Send reply error:", error);
    res.status(500).json({ error: "Failed to send reply: " + error.message });
  }
});
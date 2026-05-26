








// Check session for anomalies
app.get("/api/security/check-session", authenticate, async (req, res) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    
    // Count active sessions for this user
    const { count, error } = await supabase
      .from("user_sessions")
      .select("*", { count: "exact", head: true })
      .eq("user_id", req.user.id)
      .eq("is_active", true);
    
    if (error) throw error;
    
    // More than 2 active sessions is suspicious
    const isCompromised = count > 2;
    
    res.json({ 
      isCompromised: isCompromised,
      active_sessions_count: count || 0
    });
  } catch (error) {
    console.error("Session check error:", error);
    res.json({ isCompromised: false });
  }
});

// Revoke all other sessions
app.post("/api/security/revoke-other-sessions", authenticate, async (req, res) => {
  try {
    const currentToken = req.headers.authorization?.split(" ")[1];
    
    // Get current session ID
    const { data: currentSession } = await supabase
      .from("user_sessions")
      .select("id")
      .eq("session_token", currentToken)
      .single();
    
    // Revoke all other sessions
    await supabase
      .from("user_sessions")
      .update({ 
        is_active: false, 
        expires_at: new Date().toISOString(),
        invalidated_reason: "User revoked all other sessions"
      })
      .eq("user_id", req.user.id)
      .neq("id", currentSession?.id);
    
    res.json({ success: true });
  } catch (error) {
    console.error("Revoke sessions error:", error);
    res.status(500).json({ error: "Failed to revoke sessions" });
  }
});

// Log security events batch
app.post("/api/security/events", authenticate, async (req, res) => {
  try {
    const { events } = req.body;
    
    if (!events || !Array.isArray(events)) {
      return res.status(400).json({ error: "Invalid events data" });
    }
    
    // Insert each event
    for (const event of events) {
      await supabase
        .from("security_logs")
        .insert({
          user_id: req.user.id,
          event_type: event.type,
          details: event.details || {},
          ip_address: req.ip,
          user_agent: event.userAgent || req.headers["user-agent"],
          timestamp: new Date(event.timestamp || Date.now()).toISOString()
        });
    }
    
    res.json({ success: true, logged: events.length });
  } catch (error) {
    console.error("Security events error:", error);
    res.json({ success: false });
  }
});

// Validate session endpoint (for dashboard)
app.get("/api/auth/validate-session", authenticate, async (req, res) => {
  try {
    // Check if user still exists and is active
    const { data: user, error } = await supabase
      .from("users")
      .select("id, is_active, is_frozen")
      .eq("id", req.user.id)
      .single();
    
    if (error || !user || !user.is_active || user.is_frozen) {
      return res.status(401).json({ error: "Session invalid", code: "SESSION_EXPIRED" });
    }
    
    res.json({ valid: true });
  } catch (error) {
    res.status(401).json({ error: "Session validation failed" });
  }
});
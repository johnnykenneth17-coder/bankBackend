// ==================== SESSION MANAGEMENT ENDPOINTS ====================

// Get current user's active sessions
app.get("/api/user/sessions", authenticate, async (req, res) => {
    try {
        const sessions = await getUserActiveSessions(req.user.id);
        
        // Get current session token
        const currentToken = req.headers.authorization?.split(" ")[1];
        
        // Find which session is current
        const { data: currentSession } = await supabase
            .from("user_sessions")
            .select("id")
            .eq("session_token", currentToken)
            .eq("user_id", req.user.id)
            .single();
        
        const formattedSessions = sessions.map(session => ({
            id: session.id,
            device_name: session.device_fingerprint,
            ip_address: session.ip_address,
            last_active: session.last_activity,
            created_at: session.created_at,
            is_current: currentSession?.id === session.id
        }));
        
        res.json({ sessions: formattedSessions });
    } catch (error) {
        console.error("Get sessions error:", error);
        res.status(500).json({ error: "Failed to fetch sessions" });
    }
});

// Revoke all other sessions (keep current only)
app.post("/api/user/sessions/revoke-others", authenticate, async (req, res) => {
    try {
        const currentToken = req.headers.authorization?.split(" ")[1];
        
        if (!currentToken) {
            return res.status(400).json({ error: "Invalid session" });
        }
        
        // Get current session ID
        const { data: currentSession } = await supabase
            .from("user_sessions")
            .select("id")
            .eq("session_token", currentToken)
            .eq("user_id", req.user.id)
            .single();
        
        if (!currentSession) {
            return res.status(404).json({ error: "Current session not found" });
        }
        
        // Revoke all other sessions
        const { error } = await supabase
            .from("user_sessions")
            .update({ 
                is_active: false, 
                invalidated_reason: "User revoked all other sessions",
                expires_at: new Date()
            })
            .eq("user_id", req.user.id)
            .neq("id", currentSession.id)
            .eq("is_active", true);
        
        if (error) throw error;
        
        // Create security notification
        await supabase.from("notifications").insert({
            user_id: req.user.id,
            title: "Security: Other Sessions Revoked",
            message: "You have successfully revoked all other active sessions. Only your current device remains logged in.",
            type: "security",
            created_at: new Date()
        });
        
        res.json({ 
            success: true, 
            message: "All other sessions have been revoked" 
        });
    } catch (error) {
        console.error("Revoke sessions error:", error);
        res.status(500).json({ error: "Failed to revoke sessions" });
    }
});

// Revoke specific session
app.post("/api/user/sessions/:sessionId/revoke", authenticate, async (req, res) => {
    try {
        const { sessionId } = req.params;
        
        // Cannot revoke current session
        const currentToken = req.headers.authorization?.split(" ")[1];
        const { data: currentSession } = await supabase
            .from("user_sessions")
            .select("id")
            .eq("session_token", currentToken)
            .eq("user_id", req.user.id)
            .single();
        
        if (currentSession?.id === sessionId) {
            return res.status(400).json({ error: "Cannot revoke your current session" });
        }
        
        await revokeSession(sessionId, req.user.id, "User revoked specific session");
        
        res.json({ success: true, message: "Session revoked successfully" });
    } catch (error) {
        console.error("Revoke session error:", error);
        res.status(500).json({ error: "Failed to revoke session" });
    }
});
// auth.js - Complete session management (replace your existing login function)

// Generate unique session ID with version tracking







// Get device info for tracking










// MIDDLEWARE: Check single device session
const checkSingleDeviceSession = async (req, res, next) => {
    try {
        const authHeader = req.header("Authorization");
        const token = authHeader?.replace("Bearer ", "");

        if (!token) {
            return res.status(401).json({ error: "Please authenticate" });
        }

        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET);
        } catch (jwtError) {
            return res.status(401).json({ error: "Invalid token" });
        }

        // If token doesn't have sessionId, it's an old token
        if (!decoded.sessionId) {
            return res.status(401).json({
                error: "session_expired",
                message: "Your session has expired. Please log in again.",
                code: "SESSION_EXPIRED"
            });
        }

        // Check session validity
        const { valid, reason, code, device_name } = await checkSessionValidity(
            decoded.userId,
            decoded.sessionId,
            token
        );

        if (!valid) {
            return res.status(401).json({
                error: "session_expired",
                message: reason,
                code: code || "SESSION_INVALID",
                device_name: device_name
            });
        }

        // Update last activity
        await supabase
            .from("user_sessions")
            .update({ last_activity: new Date().toISOString() })
            .eq("session_token", token)
            .eq("is_active", true);

        req.user = { id: decoded.userId, email: decoded.email, role: decoded.role };
        req.token = token;
        req.sessionId = decoded.sessionId;
        next();
    } catch (error) {
        console.error("Session check error:", error.message);
        res.status(401).json({ error: "Please authenticate" });
    }
};

// REVOKE CURRENT SESSION (logout)
async function revokeCurrentSession(userId, sessionId, token) {
    try {
        // Update session to inactive
        const { error: sessionError } = await supabase
            .from("user_sessions")
            .update({
                is_active: false,
                is_current: false,
                invalidated_reason: "User logged out",
                expires_at: new Date().toISOString()
            })
            .eq("user_id", userId)
            .eq("session_id", sessionId);

        if (sessionError) {
            console.error("Session revoke error:", sessionError);
        }

        // Clear user's active session
        await supabase
            .from("users")
            .update({ 
                active_session_id: null,
                active_session_started_at: null
            })
            .eq("id", userId);

        return true;
    } catch (error) {
        console.error("Revoke session error:", error);
        return false;
    }
}
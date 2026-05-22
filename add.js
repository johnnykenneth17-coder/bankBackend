// auth.js - Replace the checkSessionValidity function with this

async function checkSessionValidity(userId, sessionId, token) {
    try {
        // First, get the user's current active session
        const { data: user, error: userError } = await supabase
            .from("users")
            .select("active_session_id, last_active_device")
            .eq("id", userId)
            .single();

        if (userError) {
            console.error("User fetch error:", userError);
            return { valid: true }; // Assume valid on error
        }

        // If user has no active session, this is a new login - allow it
        if (!user.active_session_id) {
            return { valid: true };
        }

        // If this token doesn't have sessionId (old token format)
        if (!sessionId) {
            return { 
                valid: false, 
                reason: "Session format invalid. Please log in again.",
                code: "SESSION_EXPIRED"
            };
        }

        // If session IDs don't match, another device logged in
        if (user.active_session_id !== sessionId) {
            // Mark this session as inactive
            await supabase
                .from("user_sessions")
                .update({
                    is_active: false,
                    invalidated_reason: "New login from another device",
                    expires_at: new Date().toISOString()
                })
                .eq("user_id", userId)
                .eq("session_id", sessionId)
                .eq("is_active", true);

            return { 
                valid: false, 
                reason: "Another device logged in",
                code: "SESSION_REPLACED",
                device_name: user.last_active_device || "Another device"
            };
        }

        return { valid: true };
    } catch (error) {
        console.error("Check session validity error:", error);
        return { valid: true }; // Assume valid on error
    }
}
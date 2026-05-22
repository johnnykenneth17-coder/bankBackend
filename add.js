// auth.js - COMPLETE REPLACEMENT of session management functions

// Generate unique session ID
function generateSessionId() {
    return crypto.randomBytes(32).toString("hex");
}


















// ==================== FIXED: GET USER ACTIVE SESSIONS ====================

async function getUserActiveSessions(userId) {
    try {
        const { data: sessions, error } = await supabase
            .from("user_sessions")
            .select("id, session_id, device_fingerprint, ip_address, user_agent, created_at, last_activity, is_current, device_name")
            .eq("user_id", userId)
            .eq("is_active", true)
            .order("created_at", { ascending: false });

        if (error) {
            console.error("[Get Sessions] Error:", error);
            return [];
        }
        
        return sessions || [];
    } catch (error) {
        console.error("[Get Sessions] Error:", error);
        return [];
    }
}

// ==================== FIXED: REVOKE SPECIFIC SESSION ====================

async function revokeSession(sessionId, userId, reason = "User initiated") {
    try {
        const { error } = await supabase
            .from("user_sessions")
            .update({
                is_active: false,
                is_current: false,
                invalidated_reason: reason,
                expires_at: new Date().toISOString(),
            })
            .eq("id", sessionId)
            .eq("user_id", userId);

        if (error) throw error;

        // If this was the active session, clear it from user record
        const { data: user } = await supabase
            .from("users")
            .select("active_session_id")
            .eq("id", userId)
            .single();

        if (user?.active_session_id === sessionId) {
            await supabase
                .from("users")
                .update({ active_session_id: null })
                .eq("id", userId);
        }

        return true;
    } catch (error) {
        console.error("[Revoke Session] Error:", error);
        return false;
    }
}

// ==================== FIXED: REVOKE CURRENT SESSION (LOGOUT) ====================

async function revokeCurrentSession(userId, sessionId, token) {
    try {
        console.log(`[Revoke Current] Revoking session for user: ${userId}, sessionId: ${sessionId}`);
        
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
            console.error("[Revoke Current] Session update error:", sessionError);
        }

        // Clear user's active session if it matches
        await supabase
            .from("users")
            .update({ 
                active_session_id: null,
                active_session_started_at: null
            })
            .eq("id", userId)
            .eq("active_session_id", sessionId);

        console.log(`[Revoke Current] Session revoked successfully`);
        return true;
    } catch (error) {
        console.error("[Revoke Current] Error:", error);
        return false;
    }
}

// Export all functions
module.exports = {
    authenticate,
    authorizeAdmin,
    checkAccountFrozen,
    logAdminAction,
    otpRateLimiter,
    preventConcurrentTransfer,
    releaseTransactionLock,
    startLockCleanup,
    checkSingleDeviceSession,
    createUserSession,
    getUserActiveSessions,
    revokeSession,
    revokeCurrentSession,
    generateSessionId,
    getDeviceInfo,
    checkSessionValidity,
    invalidateAllUserSessions,
};
// Inside your login endpoint, after creating the session, add this:

// ... after creating the session and before sending response ...

// Ensure session is fully committed before sending response
await new Promise(resolve => setTimeout(resolve, 100));

// Log successful login
await logSecurityEvent(user.id, "successful_login", {
    ip,
    fingerprint,
    device: deviceInfo.device_name,
    session_id: sessionId,
});

// Create notification about new device login if there was a previous session
if (invalidatedCount > 0) {
    await supabase.from("notifications").insert({
        user_id: user.id,
        title: "New Device Login",
        message: `Your account was accessed from a new device: ${deviceInfo.device_name} at ${new Date().toLocaleString()}. If this wasn't you, please log in immediately and change your password.`,
        type: "security",
        created_at: new Date().toISOString(),
    });
}

// Return success with session info
res.json({
    token,
    user: {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        role: user.role,
        is_frozen: user.is_frozen,
        kyc_status: user.kyc_status,
    },
    session: {
        id: sessionId,
        device: deviceInfo.device_name,
        logged_in_at: new Date().toISOString(),
    },
});
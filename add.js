app.post("/api/auth/login", authLimiter, async (req, res) => {
  try {
    const { email, password, fingerprint } = req.body;
    const ip = req.ip;

    // ... existing validation code ...
    // ... password verification code ...
    // ... account check code ...

    // Generate token
    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRE },
    );

    // Get device info
    const deviceInfo = getDeviceInfo(req);

    // ========== PUT THE NEW CODE HERE ==========
    // RIGHT HERE - Before creating the session, invalidate all existing sessions

    // CRITICAL: First, mark ALL existing sessions for this user as inactive
    const { error: invalidateError } = await supabase
      .from("user_sessions")
      .update({
        is_active: false,
        is_current: false,
        invalidated_reason: "New login from another device",
      })
      .eq("user_id", user.id)
      .eq("is_active", true);

    if (invalidateError) {
      console.error("Failed to invalidate old sessions:", invalidateError);
    }

    // Clear the active_session_id from users table
    await supabase
      .from("users")
      .update({ active_session_id: null })
      .eq("id", user.id);

    // THEN create the new session
    const sessionId = generateSessionId();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    // Insert new session
    const { data: newSession, error: sessionError } = await supabase
      .from("user_sessions")
      .insert({
        user_id: user.id,
        session_token: token,
        session_id: sessionId,
        device_fingerprint: deviceInfo.device_name,
        device_name: deviceInfo.device_name,
        ip_address: deviceInfo.ip_address,
        user_agent: deviceInfo.user_agent,
        expires_at: expiresAt,
        is_active: true,
        is_current: true,
      })
      .select()
      .single();

    if (sessionError) {
      console.error("Session insert error:", sessionError);
    } else {
      // Update user's active session ID
      await supabase
        .from("users")
        .update({
          active_session_id: sessionId,
          last_active_device: deviceInfo.device_name,
          active_session_started_at: new Date(),
          last_login: new Date(),
        })
        .eq("id", user.id);
    }
    // ========== END OF NEW CODE ==========

    // Clear failed attempts
    failedAttempts.delete(attemptsKey);

    // Log successful login
    await logSecurityEvent(user.id, "successful_login", {
      ip,
      fingerprint,
      device: deviceInfo.device_name,
    });

    // Return success
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
        device: deviceInfo.device_name,
        logged_in_at: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Login failed: " + error.message });
  }
});

// After generating token, BEFORE inserting session, invalidate ALL existing sessions for this user
// Add this code right before createUserSession call:

// CRITICAL: First, mark ALL existing sessions for this user as inactive
const { error: invalidateError } = await supabase
  .from("user_sessions")
  .update({
    is_active: false,
    is_current: false,
    invalidated_reason: "New login from another device",
  })
  .eq("user_id", user.id)
  .eq("is_active", true);

if (invalidateError) {
  console.error("Failed to invalidate old sessions:", invalidateError);
}

// Clear the active_session_id from users table
await supabase
  .from("users")
  .update({ active_session_id: null })
  .eq("id", user.id);

// THEN create the new session
const sessionId = generateSessionId();
const expiresAt = new Date();
expiresAt.setDate(expiresAt.getDate() + 7);

// Insert new session
const { data: newSession, error: sessionError } = await supabase
  .from("user_sessions")
  .insert({
    user_id: user.id,
    session_token: token,
    session_id: sessionId,
    device_fingerprint: deviceInfo.device_name,
    device_name: deviceInfo.device_name,
    ip_address: deviceInfo.ip_address,
    user_agent: deviceInfo.user_agent,
    expires_at: expiresAt,
    is_active: true,
    is_current: true,
  })
  .select()
  .single();

if (sessionError) {
  console.error("Session insert error:", sessionError);
} else {
  // Update user's active session ID
  await supabase
    .from("users")
    .update({
      active_session_id: sessionId,
      last_active_device: deviceInfo.device_name,
      active_session_started_at: new Date(),
      last_login: new Date(),
    })
    .eq("id", user.id);
}

// index.js - REPLACE the entire /api/auth/verify-passcode endpoint

app.post("/api/auth/verify-passcode", async (req, res) => {
  try {
    const { user_id, passcode } = req.body;

    // Get IP address properly
    const ip =
      req.ip ||
      req.connection?.remoteAddress ||
      req.headers["x-forwarded-for"] ||
      "unknown";
    const userAgent = req.headers["user-agent"] || "unknown";

    if (!passcode || passcode.length !== 6 || !/^\d{6}$/.test(passcode)) {
      return res.status(400).json({ error: "Invalid passcode format" });
    }

    const { data: user, error } = await supabase
      .from("users")
      .select("*")
      .eq("id", user_id)
      .single();

    if (error || !user) {
      return res.status(404).json({ error: "User not found" });
    }

    if (!user.is_active) {
      return res.status(403).json({ error: "Account is deactivated" });
    }

    if (user.is_frozen) {
      return res.status(403).json({ error: "Account is frozen" });
    }

    const maxAttempts = 5;
    const attemptWindow = 15 * 60 * 1000;

    if (user.passcode_attempts >= maxAttempts) {
      const lastAttempt = new Date(user.last_passcode_attempt);
      if (Date.now() - lastAttempt < attemptWindow) {
        return res
          .status(429)
          .json({ error: "Too many incorrect attempts. Try again later." });
      } else {
        await supabase
          .from("users")
          .update({ passcode_attempts: 0 })
          .eq("id", user_id);
      }
    }

    const isValid = await bcrypt.compare(passcode, user.passcode_hash);

    if (!isValid) {
      const newAttempts = (user.passcode_attempts || 0) + 1;
      await supabase
        .from("users")
        .update({
          passcode_attempts: newAttempts,
          last_passcode_attempt: new Date(),
        })
        .eq("id", user_id);
      return res.status(401).json({
        error: "Invalid passcode",
        attempts_remaining: maxAttempts - newAttempts,
      });
    }

    // Reset attempts on success
    await supabase
      .from("users")
      .update({
        passcode_attempts: 0,
        last_passcode_attempt: null,
        last_login: new Date(),
      })
      .eq("id", user_id);

    // ========== STRICT SESSION MANAGEMENT (SAME AS EMAIL LOGIN) ==========
    const deviceInfo = getDeviceInfo(req);
    const sessionVersion = Math.floor(Date.now() / 1000);
    const sessionId = generateSessionId();

    // STEP 1: Get ALL existing active sessions for this user
    const { data: existingSessions } = await supabase
      .from("user_sessions")
      .select("id, session_id, device_name, session_token")
      .eq("user_id", user.id)
      .eq("is_active", true);

    // STEP 2: Generate new token with session info
    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        role: user.role,
        sessionId: sessionId,
        sessionVersion: sessionVersion,
        issuedAt: Date.now(),
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRE || "7d" }
    );

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    // STEP 3: Insert the new session
    const { error: sessionError } = await supabase
      .from("user_sessions")
      .insert({
        user_id: user.id,
        session_token: token,
        session_id: sessionId,
        device_fingerprint: deviceInfo.device_name,
        device_name: deviceInfo.device_name,
        ip_address: deviceInfo.ip_address,
        user_agent: deviceInfo.user_agent,
        expires_at: expiresAt.toISOString(),
        is_active: true,
        is_current: true,
        session_version: sessionVersion,
        created_at: new Date().toISOString(),
        last_activity: new Date().toISOString(),
      });

    if (sessionError) {
      console.error("Session insert error:", sessionError);
    }

    // STEP 4: Update user record with new active session
    await supabase
      .from("users")
      .update({
        active_session_id: sessionId,
        last_active_device: deviceInfo.device_name,
        active_session_started_at: new Date().toISOString(),
        last_login: new Date().toISOString(),
        session_version: sessionVersion,
      })
      .eq("id", user.id);

    // STEP 5: Invalidate ALL existing sessions (excluding the new one)
    if (existingSessions && existingSessions.length > 0) {
      console.log(
        `[Passcode Login] Invalidating ${existingSessions.length} old session(s) for user ${user.id}`
      );

      // Get the IDs of sessions to invalidate
      const oldSessionIds = existingSessions.map(s => s.id);

      await supabase
        .from("user_sessions")
        .update({
          is_active: false,
          is_current: false,
          invalidated_reason: `New passcode login from ${deviceInfo.device_name}`,
          expires_at: new Date().toISOString(),
        })
        .in("id", oldSessionIds);

      // Send notifications for each old session
      for (const oldSession of existingSessions) {
        await supabase
          .from("notifications")
          .insert({
            user_id: user.id,
            title: "New Device Login (Passcode)",
            message: `Your account was accessed via passcode from: ${deviceInfo.device_name}. Your session on ${oldSession.device_name || "another device"} was terminated. If this wasn't you, log in and change your password immediately.`,
            type: "security",
            created_at: new Date().toISOString(),
          })
          .catch(e => console.error("Notification error:", e));
      }
    }

    // Log successful login
    await logSecurityEvent(user.id, "successful_passcode_login", {
      ip,
      device: deviceInfo.device_name,
      session_id: sessionId,
    });

    // Return response
    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        role: user.role,
        admin_role: user.admin_role,
        admin_permissions: user.admin_permissions,
        is_frozen: user.is_frozen,
        kyc_status: user.kyc_status,
      },
      session: {
        id: sessionId,
        device: deviceInfo.device_name,
        logged_in_at: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("Passcode verification error:", error);
    res.status(500).json({ error: "Verification failed: " + error.message });
  }
});
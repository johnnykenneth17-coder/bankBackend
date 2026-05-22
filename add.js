// Login
app.post("/api/auth/login", authLimiter, async (req, res) => {
  try {
    const { email, password, fingerprint } = req.body;
    const ip = req.ip;

    // Check failed attempts
    const attemptsKey = `${ip}:${email}`;
    const attempts = failedAttempts.get(attemptsKey) || {
      count: 0,
      firstAttempt: Date.now(),
    };

    // Reset after 15 minutes
    if (Date.now() - attempts.firstAttempt > 15 * 60 * 1000) {
      attempts.count = 0;
      attempts.firstAttempt = Date.now();
    }

    if (attempts.count >= 5) {
      return res.status(429).json({
        error: "Too many failed attempts. Account temporarily locked.",
      });
    }

    // Get user
    const { data: user, error } = await supabase
      .from("users")
      .select("*")
      .eq("email", email)
      .single();

    if (error || !user) {
      attempts.count++;
      failedAttempts.set(attemptsKey, attempts);
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Check password
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      attempts.count++;
      failedAttempts.set(attemptsKey, attempts);

      await logSecurityEvent(user.id, "failed_login", { ip, fingerprint });

      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Check if account is active
    if (!user.is_active) {
      return res.status(403).json({ error: "Account is deactivated" });
    }

    // Check if account is frozen
    if (user.is_frozen) {
      return res.status(403).json({
        error: "Account frozen",
        freeze_reason: user.freeze_reason,
        unfreeze_method: user.unfreeze_method,
      });
    }

    // Check device fingerprint
    if (
      fingerprint &&
      user.device_fingerprint &&
      fingerprint !== user.device_fingerprint
    ) {
      await logSecurityEvent(user.id, "new_device_login", { ip, fingerprint });
    }

    // Update device fingerprint
    if (fingerprint && !user.device_fingerprint) {
      await supabase
        .from("users")
        .update({ device_fingerprint: fingerprint })
        .eq("id", user.id);
    }

    // Clear failed attempts on successful login
    failedAttempts.delete(attemptsKey);

    // Check 2FA
    if (user.two_factor_enabled) {
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

      await supabase.from("otps").insert({
        user_id: user.id,
        otp_code: otp,
        otp_type: "login",
        expires_at: expiresAt,
      });

      await sendOTPEmail(user.email, otp);

      return res.json({
        requiresTwoFactor: true,
        userId: user.id,
        message: "OTP sent to your email",
      });
    }

    // Generate token
    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        role: user.role,
        fingerprint: fingerprint,
        issuedAt: Date.now(),
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRE || "7d" },
    );

    // Get device info
    const deviceInfo = getDeviceInfo(req);

    // ========== CHECK IF USER HAD PREVIOUS SESSION ==========
    const { data: existingUserData } = await supabase
      .from("users")
      .select("active_session_id")
      .eq("id", user.id)
      .single();

    const wasPreviouslyLoggedIn = existingUserData?.active_session_id;

    // ========== INVALIDATE ALL EXISTING SESSIONS ==========
    // First, mark ALL existing sessions for this user as inactive
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

    // ========== CREATE NEW SESSION ==========
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

    // Log successful login
    await logSecurityEvent(user.id, "successful_login", {
      ip,
      fingerprint,
      device: deviceInfo.device_name,
    });

    // Create notification about new device login (if there was a previous session)
    if (wasPreviouslyLoggedIn) {
      await supabase.from("notifications").insert({
        user_id: user.id,
        title: "New Device Login",
        message: `Your account was accessed from a new device: ${deviceInfo.device_name} at ${new Date().toLocaleString()}. If this wasn't you, please log in immediately and change your password.`,
        type: "security",
        created_at: new Date(),
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
        device: deviceInfo.device_name,
        logged_in_at: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Login failed: " + error.message });
  }
});

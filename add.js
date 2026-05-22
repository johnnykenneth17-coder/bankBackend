// In your /api/auth/login route, REPLACE the session management block
// (the section from "// ========== SESSION MANAGEMENT ==========" to the res.json)
// with this reordered version:

// ========== SESSION MANAGEMENT ==========
const deviceInfo = getDeviceInfo(req);
const sessionVersion = Date.now();
const sessionId = generateSessionId();

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
  { expiresIn: process.env.JWT_EXPIRE || "7d" },
);

const expiresAt = new Date();
expiresAt.setDate(expiresAt.getDate() + 7);

// STEP 1: Write the new session row first
const { error: sessionError } = await supabase.from("user_sessions").insert({
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

// STEP 2: Atomically update the user record to point to the NEW session
// before invalidating old ones — this closes the race condition window
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

// STEP 3: NOW invalidate old sessions (excluding the one we just created)
const { data: oldSessions } = await supabase
  .from("user_sessions")
  .select("id, session_id, device_name")
  .eq("user_id", user.id)
  .eq("is_active", true)
  .neq("session_id", sessionId); // Don't touch the new session

if (oldSessions && oldSessions.length > 0) {
  await supabase
    .from("user_sessions")
    .update({
      is_active: false,
      is_current: false,
      invalidated_reason: "New login from another device",
      expires_at: new Date().toISOString(),
    })
    .eq("user_id", user.id)
    .eq("is_active", true)
    .neq("session_id", sessionId);

  // Notify about displaced sessions
  for (const old of oldSessions) {
    await supabase
      .from("notifications")
      .insert({
        user_id: user.id,
        title: "New Device Login",
        message: `Your account was accessed from a new device: ${deviceInfo.device_name}. Your session on ${old.device_name || "another device"} was terminated.`,
        type: "security",
        created_at: new Date().toISOString(),
      })
      .catch((e) => console.error("Notification error:", e));
  }
}

await logSecurityEvent(user.id, "successful_login", {
  ip,
  fingerprint,
  device: deviceInfo.device_name,
  session_id: sessionId,
});

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

app.post("/api/auth/login", authLimiter, async (req, res) => {
  try {
    const { email, password, fingerprint } = req.body;
    const ip = req.ip;

    // ========== FAILED ATTEMPTS CHECK ==========
    const attemptsKey = `${ip}:${email}`;
    const attempts = failedAttempts.get(attemptsKey) || {
      count: 0,
      firstAttempt: Date.now(),
    };

    if (Date.now() - attempts.firstAttempt > 15 * 60 * 1000) {
      attempts.count = 0;
      attempts.firstAttempt = Date.now();
    }

    if (attempts.count >= 5) {
      return res.status(429).json({
        error: "Too many failed attempts. Account temporarily locked.",
      });
    }

    // ========== FETCH USER ==========
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

    // ========== PASSWORD CHECK ==========
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      attempts.count++;
      failedAttempts.set(attemptsKey, attempts);
      await logSecurityEvent(user.id, "failed_login", { ip, fingerprint });
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // ========== ACCOUNT STATUS CHECKS ==========
    if (!user.is_active) {
      return res.status(403).json({ error: "Account is deactivated" });
    }

    if (user.is_frozen) {
      return res.status(403).json({
        error: "Account frozen",
        freeze_reason: user.freeze_reason,
        unfreeze_method: user.unfreeze_method,
      });
    }

    // Clear failed attempts on successful credential check
    failedAttempts.delete(attemptsKey);

    // ========== 2FA CHECK ==========
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

    // ========== SESSION MANAGEMENT ==========
    const deviceInfo = getDeviceInfo(req);
    const sessionVersion = Date.now();

    // generateSessionId() takes no args — do NOT pass user.id
    const sessionId = generateSessionId();

    // Build JWT with session info embedded
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
      { expiresIn: process.env.JWT_EXPIRE || "7d" },
    );

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    // STEP 1: Insert the new session row FIRST
    // This must exist before we update active_session_id on the user
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
      // Non-fatal — continue, session check will still work via users.active_session_id
    }

    // STEP 2: Update the user record to point to the NEW session immediately
    // Doing this BEFORE invalidating old sessions closes the race condition window.
    // Any session check that runs right now will see the correct active_session_id
    // and match it against the new token's sessionId — no phantom logout.
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

    // STEP 3: NOW invalidate all OLD sessions (explicitly exclude the new one)
    const { data: oldSessions } = await supabase
      .from("user_sessions")
      .select("id, session_id, device_name")
      .eq("user_id", user.id)
      .eq("is_active", true)
      .neq("session_id", sessionId); // Never touch the session we just created

    if (oldSessions && oldSessions.length > 0) {
      console.log(
        `Invalidating ${oldSessions.length} old session(s) for user ${user.id}`,
      );

      await supabase
        .from("user_sessions")
        .update({
          is_active: false,
          is_current: false,
          invalidated_reason: "New login from another device",
          expires_at: new Date().toISOString(),
        })
        .eq("user_id", user.id)
        .eq("is_active", true)
        .neq("session_id", sessionId); // Safety guard — never kill the new session

      // Send a notification for each displaced session
      for (const old of oldSessions) {
        await supabase
          .from("notifications")
          .insert({
            user_id: user.id,
            title: "New Device Login",
            message: `Your account was accessed from: ${deviceInfo.device_name}. Your session on ${old.device_name || "another device"} was terminated. If this wasn't you, log in and change your password immediately.`,
            type: "security",
            created_at: new Date().toISOString(),
          })
          .catch((e) => console.error("Notification insert error:", e));
      }
    } else {
      console.log(`No old sessions to invalidate for user ${user.id}`);
    }

    // ========== LOG SUCCESSFUL LOGIN ==========
    await logSecurityEvent(user.id, "successful_login", {
      ip,
      fingerprint,
      device: deviceInfo.device_name,
      session_id: sessionId,
    });

    // ========== RESPOND ==========
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
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Login failed: " + error.message });
  }
});

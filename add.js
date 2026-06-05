



// Resend 2FA login OTP
app.post("/api/auth/resend-2fa-otp", async (req, res) => {
  try {
    const { user_id } = req.body;
    
    const { data: user } = await supabase
      .from("users")
      .select("email")
      .eq("id", user_id)
      .single();
    
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    
    // Invalidate old OTPs
    await supabase
      .from("otps")
      .update({ is_used: true })
      .eq("user_id", user_id)
      .eq("otp_type", "login_2fa")
      .eq("is_used", false);
    
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    
    await supabase.from("otps").insert({
      user_id: user_id,
      otp_code: otpCode,
      otp_type: "login_2fa",
      expires_at: expiresAt,
      is_used: false,
    });
    
    await sendOTPEmail(user.email, otpCode, "2fa");
    
    res.json({ success: true });
  } catch (error) {
    console.error("Resend 2FA OTP error:", error);
    res.status(500).json({ error: "Failed to resend code" });
  }
});








// ==================== 2FA VERIFICATION ENDPOINT (GATE ONLY) ====================

let twoFactorAttempts = new Map(); // Track OTP attempts per user

app.post("/api/auth/verify-2fa", async (req, res) => {
  try {
    const { tempToken, otp_code } = req.body;
    const ip = req.ip;
    
    // Step 1: Verify the temporary token
    let decoded;
    try {
      decoded = jwt.verify(tempToken, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ 
        error: "Invalid or expired session. Please login again.",
        code: "SESSION_EXPIRED"
      });
    }
    
    // Verify this is a temporary 2FA token
    if (!decoded.tempAuth || decoded.purpose !== "2fa_verification") {
      return res.status(401).json({ 
        error: "Invalid verification session",
        code: "INVALID_SESSION"
      });
    }
    
    const userId = decoded.userId;
    
    // Step 2: Check OTP attempts limit
    const attemptsKey = `${ip}:${userId}`;
    const attempts = twoFactorAttempts.get(attemptsKey) || { count: 0, firstAttempt: Date.now() };
    
    // Reset attempts after 15 minutes
    if (Date.now() - attempts.firstAttempt > 15 * 60 * 1000) {
      attempts.count = 0;
      attempts.firstAttempt = Date.now();
    }
    
    if (attempts.count >= 5) {
      return res.status(429).json({
        error: "Too many incorrect OTP attempts. Please login again.",
        code: "TOO_MANY_ATTEMPTS"
      });
    }
    
    // Step 3: Verify OTP
    const { data: otpRecord, error: otpError } = await supabase
      .from("otps")
      .select("*")
      .eq("user_id", userId)
      .eq("otp_code", otp_code)
      .eq("otp_type", "login_2fa")
      .eq("is_used", false)
      .single();
    
    if (otpError || !otpRecord) {
      // Increment failed attempts
      attempts.count++;
      twoFactorAttempts.set(attemptsKey, attempts);
      
      const remaining = 5 - attempts.count;
      return res.status(401).json({
        error: "Invalid verification code",
        attempts_remaining: remaining,
        code: "INVALID_OTP"
      });
    }
    
    // Check expiry
    if (new Date(otpRecord.expires_at) < new Date()) {
      return res.status(401).json({
        error: "Verification code has expired. Please login again.",
        code: "OTP_EXPIRED"
      });
    }
    
    // Step 4: Mark OTP as used
    await supabase
      .from("otps")
      .update({ is_used: true })
      .eq("id", otpRecord.id);
    
    // Step 5: Clear failed attempts on success
    twoFactorAttempts.delete(attemptsKey);
    
    // Step 6: Get fresh user data
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("*")
      .eq("id", userId)
      .single();
    
    if (userError || !user) {
      return res.status(404).json({ error: "User not found" });
    }
    
    // Step 7: CREATE FULL SESSION (same as successful login)
    const deviceInfo = getDeviceInfo(req);
    const sessionVersion = Math.floor(Date.now() / 1000);
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
      { expiresIn: process.env.JWT_EXPIRE || "7d" }
    );
    
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);
    
    // Get existing sessions to invalidate
    const { data: existingSessions } = await supabase
      .from("user_sessions")
      .select("id, session_id, device_name")
      .eq("user_id", user.id)
      .eq("is_active", true);
    
    // Insert new session
    await supabase.from("user_sessions").insert({
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
    
    // Update user record
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
    
    // Invalidate old sessions
    if (existingSessions && existingSessions.length > 0) {
      await supabase
        .from("user_sessions")
        .update({
          is_active: false,
          is_current: false,
          invalidated_reason: `New 2FA login from ${deviceInfo.device_name}`,
          expires_at: new Date().toISOString(),
        })
        .in("id", existingSessions.map(s => s.id));
      
      // Send notifications
      for (const oldSession of existingSessions) {
        await supabase.from("notifications").insert({
          user_id: user.id,
          title: "New Device Login (2FA)",
          message: `Your account was accessed via 2FA from: ${deviceInfo.device_name}. Your session on ${oldSession.device_name || "another device"} was terminated.`,
          type: "security",
          created_at: new Date().toISOString(),
        }).catch(e => console.error("Notification error:", e));
      }
    }
    
    // Log successful 2FA verification
    await logSecurityEvent(user.id, "successful_2fa_verification", {
      ip,
      device: deviceInfo.device_name,
      session_id: sessionId,
    });
    
    // Return full login response
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
    console.error("2FA verification error:", error);
    res.status(500).json({ error: "Verification failed: " + error.message });
  }
});

// Resend 2FA OTP endpoint
app.post("/api/auth/resend-2fa-otp", async (req, res) => {
  try {
    const { tempToken } = req.body;
    
    // Verify temporary token
    let decoded;
    try {
      decoded = jwt.verify(tempToken, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ 
        error: "Invalid session. Please login again.",
        code: "SESSION_EXPIRED"
      });
    }
    
    if (!decoded.tempAuth || decoded.purpose !== "2fa_verification") {
      return res.status(401).json({ error: "Invalid verification session" });
    }
    
    const userId = decoded.userId;
    
    // Get user email
    const { data: user } = await supabase
      .from("users")
      .select("email")
      .eq("id", userId)
      .single();
    
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    
    // Invalidate old OTPs
    await supabase
      .from("otps")
      .update({ is_used: true })
      .eq("user_id", userId)
      .eq("otp_type", "login_2fa")
      .eq("is_used", false);
    
    // Generate new OTP
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    
    await supabase.from("otps").insert({
      user_id: userId,
      otp_code: otpCode,
      otp_type: "login_2fa",
      expires_at: expiresAt,
      is_used: false,
    });
    
    await sendOTPEmail(user.email, otpCode, "2fa");
    
    res.json({ success: true, message: "New code sent to your email" });
  } catch (error) {
    console.error("Resend 2FA OTP error:", error);
    res.status(500).json({ error: "Failed to resend code" });
  }
});
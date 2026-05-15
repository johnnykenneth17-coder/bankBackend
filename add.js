// ==================== EXTENDED LOGIN ROUTES ====================







// Set passcode (authenticated user)
app.post("/api/user/set-passcode", authenticate, async (req, res) => {
  try {
    const { passcode } = req.body;
    if (!passcode || passcode.length !== 6 || !/^\d{6}$/.test(passcode)) {
      return res
        .status(400)
        .json({ error: "Passcode must be exactly 6 digits" });
    }
    const hashedPasscode = await bcrypt.hash(passcode, 10);
    await supabase
      .from("users")
      .update({
        passcode_hash: hashedPasscode,
        passcode_set_at: new Date(),
        passcode_attempts: 0,
      })
      .eq("id", req.user.id);
    res.json({ success: true, message: "Passcode set successfully" });
  } catch (error) {
    console.error("Set passcode error:", error);
    res.status(500).json({ error: "Failed to set passcode" });
  }
});

// Change passcode (authenticated user)
app.post("/api/user/change-passcode", authenticate, async (req, res) => {
  try {
    const { current_passcode, new_passcode } = req.body;
    if (
      !new_passcode ||
      new_passcode.length !== 6 ||
      !/^\d{6}$/.test(new_passcode)
    ) {
      return res
        .status(400)
        .json({ error: "New passcode must be exactly 6 digits" });
    }
    const { data: user, error } = await supabase
      .from("users")
      .select("passcode_hash")
      .eq("id", req.user.id)
      .single();
    if (error) throw error;
    if (user.passcode_hash) {
      if (!current_passcode)
        return res.status(400).json({ error: "Current passcode required" });
      const isValid = await bcrypt.compare(
        current_passcode,
        user.passcode_hash,
      );
      if (!isValid)
        return res.status(401).json({ error: "Current passcode is incorrect" });
    }
    const hashedPasscode = await bcrypt.hash(new_passcode, 10);
    await supabase
      .from("users")
      .update({
        passcode_hash: hashedPasscode,
        passcode_set_at: new Date(),
        passcode_attempts: 0,
      })
      .eq("id", req.user.id);
    res.json({ success: true, message: "Passcode changed successfully" });
  } catch (error) {
    console.error("Change passcode error:", error);
    res.status(500).json({ error: "Failed to change passcode" });
  }
});

// Check if user has passcode (for settings)
app.get("/api/user/has-passcode", authenticate, async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from("users")
      .select("passcode_hash")
      .eq("id", req.user.id)
      .single();
    if (error) throw error;
    res.json({
      has_passcode: !!(user.passcode_hash && user.passcode_hash !== null),
    });
  } catch (error) {
    console.error("Has passcode error:", error);
    res.status(500).json({ error: "Failed to check passcode status" });
  }
});

// Face verification for login
app.post("/api/auth/verify-face", async (req, res) => {
  try {
    const { face_descriptor } = req.body;
    if (!face_descriptor || !Array.isArray(face_descriptor)) {
      return res.status(400).json({ error: "Invalid face descriptor" });
    }

    const { data: descriptors, error } = await supabase
      .from("face_descriptors")
      .select(
        "user_id, descriptor, users!inner(id, email, first_name, last_name, role, is_active, is_frozen)",
      )
      .eq("is_active", true);

    if (error) throw error;

    let bestMatch = null;
    let bestDistance = 0.6;

    for (const record of descriptors || []) {
      const distance = calculateEuclideanDistance(
        face_descriptor,
        record.descriptor,
      );
      if (distance < bestDistance) {
        bestDistance = distance;
        bestMatch = record;
      }
    }

    if (!bestMatch) {
      await supabase
        .from("face_verification_logs")
        .insert({
          user_id: null,
          verification_type: "login",
          success: false,
          ip_address: req.ip,
        });
      return res.status(401).json({ error: "Face not recognized" });
    }

    const user = bestMatch.users;
    if (!user.is_active)
      return res.status(403).json({ error: "Account is deactivated" });
    if (user.is_frozen)
      return res.status(403).json({ error: "Account is frozen" });

    await supabase
      .from("face_verification_logs")
      .insert({
        user_id: user.id,
        verification_type: "login",
        success: true,
        liveness_score: 0.95,
        ip_address: req.ip,
      });
    await supabase
      .from("users")
      .update({ last_login: new Date() })
      .eq("id", user.id);

    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRE },
    );

    res.json({
      success: true,
      matched: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("Face verification error:", error);
    res.status(500).json({ error: "Face verification failed" });
  }
});

// Resend OTP
app.post("/api/auth/resend-otp", async (req, res) => {
  try {
    const { identifier } = req.body;
    const { data: user, error } = await supabase
      .from("users")
      .select("id, email")
      .eq("email", identifier)
      .single();
    if (error || !user)
      return res.status(404).json({ error: "User not found" });

    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await supabase
      .from("otps")
      .delete()
      .eq("user_id", user.id)
      .eq("otp_type", "login");
    await supabase
      .from("otps")
      .insert({
        user_id: user.id,
        otp_code: otpCode,
        otp_type: "login",
        expires_at: expiresAt,
      });
    await sendOTPEmail(user.email, otpCode);
    res.json({ success: true, message: "OTP sent successfully" });
  } catch (error) {
    console.error("Resend OTP error:", error);
    res.status(500).json({ error: "Failed to resend OTP" });
  }
});

// Verify OTP for login
app.post("/api/auth/verify-otp-login", async (req, res) => {
  try {
    const { identifier, otp_code, transaction_id } = req.body;
    const { data: user, error } = await supabase
      .from("users")
      .select("*")
      .eq("email", identifier)
      .single();
    if (error || !user)
      return res.status(404).json({ error: "User not found" });

    const { data: otpRecord, error: otpError } = await supabase
      .from("otps")
      .select("*")
      .eq("user_id", user.id)
      .eq("otp_code", otp_code)
      .eq("otp_type", "login")
      .eq("is_used", false)
      .single();

    if (otpError || !otpRecord)
      return res.status(401).json({ error: "Invalid OTP" });
    if (new Date(otpRecord.expires_at) < new Date())
      return res.status(401).json({ error: "OTP has expired" });

    await supabase
      .from("otps")
      .update({ is_used: true })
      .eq("id", otpRecord.id);
    await supabase
      .from("users")
      .update({ last_login: new Date() })
      .eq("id", user.id);

    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRE },
    );

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("OTP verification error:", error);
    res.status(500).json({ error: "Verification failed" });
  }
});

// Helper function for Euclidean distance
function calculateEuclideanDistance(desc1, desc2) {
  let sum = 0;
  for (let i = 0; i < desc1.length; i++) {
    sum += Math.pow(desc1[i] - desc2[i], 2);
  }
  return Math.sqrt(sum);
}

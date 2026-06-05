// index.js - REPLACE the forgot-password endpoint

app.post("/api/auth/forgot-password", async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: "Email required" });
  }

  const normalizedEmail = email.trim().toLowerCase();

  console.log(`📧 Password reset requested for: ${normalizedEmail}`);

  try {
    // STEP 1: Check if user exists FIRST
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("id, email, first_name")
      .eq("email", normalizedEmail)
      .maybeSingle();

    // IMPORTANT: If user doesn't exist, return generic message (don't reveal that email doesn't exist)
    if (!user) {
      console.log(`User not found: ${normalizedEmail}`);
      // Still return success to prevent email enumeration
      return res.json({
        success: true,
        message: "If your email is registered, you will receive a reset code.",
      });
    }

    // STEP 2: User exists - generate OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    console.log(`Generated OTP ${otp} for user ${user.id}`);

    // Mark any existing OTPs as used
    await supabase
      .from("password_resets")
      .update({ used: true })
      .eq("email", normalizedEmail)
      .eq("used", false);

    // Insert new OTP
    const { error: insertError } = await supabase
      .from("password_resets")
      .insert({
        email: normalizedEmail,
        otp: otp,
        expires_at: expiresAt.toISOString(),
        used: false,
        created_at: new Date().toISOString(),
      });

    if (insertError) {
      console.error("Insert OTP error:", insertError);
      return res.status(500).json({ error: "Failed to generate reset code" });
    }

    // STEP 3: Send email with OTP
    const emailSent = await sendOTPEmail(normalizedEmail, otp, "reset");

    if (!emailSent) {
      console.error(`Failed to send email to ${normalizedEmail}`);
      // Still return success to user (don't reveal email failure)
      return res.json({
        success: true,
        message: "If your email is registered, you will receive a reset code.",
      });
    }

    console.log(`✅ Reset email sent to ${normalizedEmail}`);
    res.json({
      success: true,
      message: "Reset code sent to your email. Please check your inbox and spam folder.",
    });
  } catch (error) {
    console.error("Forgot password error:", error);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});
// Step 1: Request OTP - FIXED VERSION
app.post("/api/auth/forgot-password", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });

  const normalizedEmail = email.trim().toLowerCase();

  // Check if user exists (but don't reveal)
  const { data: user, error: userError } = await supabase
    .from("users")
    .select("id")
    .eq("email", normalizedEmail)
    .maybeSingle(); // Use maybeSingle() instead of single() to avoid errors

  // Always return success to prevent email enumeration
  if (!user) {
    console.log(`Password reset requested for non-existent email: ${normalizedEmail}`);
    return res.json({
      message: "If your email is registered, you will receive a reset code.",
    });
  }

  // Generate 6-digit OTP
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  try {
    // Use UPSERT instead of DELETE + INSERT to avoid race conditions
    const { error: upsertError } = await supabase
      .from("password_resets")
      .upsert({
        email: normalizedEmail,
        otp: otp,
        expires_at: expiresAt.toISOString(),
        used: false,
        created_at: new Date().toISOString()
      }, {
        onConflict: 'email', // This handles the unique constraint
        ignoreDuplicates: false
      });

    if (upsertError) {
      console.error("Upsert OTP error:", upsertError);
      return res.status(500).json({ error: "Failed to generate reset code" });
    }
  } catch (dbError) {
    console.error("Database error:", dbError);
    return res.status(500).json({ error: "Database error occurred" });
  }

  // Send email
  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: normalizedEmail,
      subject: "Password Reset Code - FEECENT",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #6b21a8;">FEECENT Password Reset</h2>
          <p>You requested to reset your password. Your verification code is:</p>
          <div style="font-size: 32px; font-weight: bold; padding: 20px; background: #f3f4f6; text-align: center; letter-spacing: 5px;">
            ${otp}
          </div>
          <p>This code will expire in 10 minutes.</p>
          <p>If you didn't request this, please ignore this email.</p>
          <hr>
          <p style="font-size: 12px; color: #6b7280;">FEECENT - Secure Digital Banking</p>
        </div>
      `,
    });
  } catch (err) {
    console.error("Email error:", err);
    return res.status(500).json({ error: "Failed to send email. Please try again." });
  }

  res.json({ message: "Reset code sent to your email" });
});
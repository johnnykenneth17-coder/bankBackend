// ==================== FORGOT PASSWORD ROUTES (EMAIL ONLY) ====================

// Step 1: Request OTP via Email Only
app.post("/api/auth/forgot-password", async (req, res) => {
  const { email } = req.body;
  
  if (!email) {
    return res.status(400).json({ error: "Email required" });
  }

  const normalizedEmail = email.trim().toLowerCase();
  
  console.log(`📧 Password reset requested for: ${normalizedEmail}`);

  try {
    // Check if user exists
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("id, email")
      .eq("email", normalizedEmail)
      .maybeSingle();

    // Always return success to prevent email enumeration
    if (!user) {
      console.log(`User not found: ${normalizedEmail}`);
      return res.json({
        message: "If your email is registered, you will receive a reset code.",
      });
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    
    console.log(`Generated OTP ${otp} for user ${user.id}`);

    // First, mark any existing OTPs as used (soft delete)
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
        created_at: new Date().toISOString()
      });

    if (insertError) {
      console.error("Insert OTP error:", insertError);
      return res.status(500).json({ error: "Failed to generate reset code" });
    }

    // Send email with OTP
    const emailSent = await sendOTPEmail(normalizedEmail, otp);
    
    if (!emailSent) {
      console.error(`Failed to send email to ${normalizedEmail}`);
      // Still return success to user (don't reveal email failure)
      return res.json({ 
        message: "If your email is registered, you will receive a reset code. Please check your spam folder."
      });
    }

    console.log(`✅ Reset email sent to ${normalizedEmail}`);
    res.json({ 
      message: "Reset code sent to your email. Please check your inbox and spam folder."
    });
    
  } catch (error) {
    console.error("Forgot password error:", error);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// Step 2: Verify OTP
app.post("/api/auth/verify-reset-otp", async (req, res) => {
  const { email, otp } = req.body;
  
  if (!email || !otp) {
    return res.status(400).json({ error: "Email and code required" });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const normalizedOtp = otp.trim();

  console.log(`Verifying OTP for ${normalizedEmail}`);

  try {
    const { data: record, error } = await supabase
      .from("password_resets")
      .select("*")
      .eq("email", normalizedEmail)
      .eq("otp", normalizedOtp)
      .eq("used", false)
      .single();

    if (error || !record) {
      console.log("Invalid OTP:", error);
      return res.status(400).json({ error: "Invalid or expired code" });
    }

    if (new Date(record.expires_at) < new Date()) {
      console.log("Expired OTP for:", normalizedEmail);
      return res.status(400).json({ error: "Code has expired. Please request a new one." });
    }

    // Mark as used
    await supabase
      .from("password_resets")
      .update({ used: true })
      .eq("id", record.id);

    console.log(`✅ OTP verified successfully for ${normalizedEmail}`);
    res.json({ valid: true });
    
  } catch (error) {
    console.error("Verify OTP error:", error);
    res.status(500).json({ error: "Verification failed" });
  }
});

// Step 3: Reset Password
app.post("/api/auth/reset-password", async (req, res) => {
  const { email, otp, new_password } = req.body;
  
  if (!email || !otp || !new_password) {
    return res.status(400).json({ error: "All fields required" });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const normalizedOtp = otp.trim();

  console.log(`Resetting password for ${normalizedEmail}`);

  try {
    // Verify OTP again (must be used = true from previous step)
    const { data: record, error } = await supabase
      .from("password_resets")
      .select("*")
      .eq("email", normalizedEmail)
      .eq("otp", normalizedOtp)
      .eq("used", true)
      .single();

    if (error || !record) {
      console.log("Invalid reset session:", error);
      return res.status(400).json({ error: "Invalid or expired reset session" });
    }

    if (new Date(record.expires_at) < new Date()) {
      return res.status(400).json({ error: "Reset session has expired. Please request a new code." });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(new_password, 10);
    
    // Update user password
    const { error: updateError } = await supabase
      .from("users")
      .update({ 
        password_hash: hashedPassword,
        updated_at: new Date().toISOString()
      })
      .eq("email", normalizedEmail);

    if (updateError) {
      console.error("Password update error:", updateError);
      return res.status(500).json({ error: "Failed to update password" });
    }

    // Delete the used OTP record (cleanup)
    await supabase
      .from("password_resets")
      .delete()
      .eq("id", record.id);

    console.log(`✅ Password reset successfully for ${normalizedEmail}`);
    res.json({ message: "Password reset successful. You can now login with your new password." });
    
  } catch (error) {
    console.error("Reset password error:", error);
    res.status(500).json({ error: "Failed to reset password" });
  }
});

// ==================== SIMPLIFIED EMAIL FUNCTION ====================

async function sendOTPEmail(email, otp) {
  console.log(`📧 Attempting to send OTP ${otp} to ${email}`);
  
  // Check SMTP configuration
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.error("❌ SMTP credentials missing. Email not sent.");
    return false;
  }
  
  try {
    // Simple HTML email (works with all providers)
    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>FEECENT Password Reset</title>
      </head>
      <body style="font-family: Arial, sans-serif; margin: 0; padding: 20px; background: #f5f5f5;">
        <div style="max-width: 500px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden;">
          <div style="background: #6b21a8; padding: 20px; text-align: center;">
            <h1 style="color: white; margin: 0;">FEECENT</h1>
            <p style="color: #d8b4fe; margin: 5px 0 0;">Secure Digital Banking</p>
          </div>
          
          <div style="padding: 30px 20px;">
            <h2 style="color: #333; margin-top: 0;">Password Reset</h2>
            <p style="color: #666;">Your verification code is:</p>
            
            <div style="background: #f8fafc; padding: 20px; text-align: center; margin: 20px 0; border-radius: 8px;">
              <span style="font-size: 42px; font-weight: bold; letter-spacing: 8px; color: #6b21a8; font-family: monospace;">${otp}</span>
            </div>
            
            <p style="color: #666; font-size: 14px;">This code expires in <strong>10 minutes</strong>.</p>
            <p style="color: #999; font-size: 12px; margin-top: 20px;">If you didn't request this, please ignore this email.</p>
          </div>
        </div>
      </body>
      </html>
    `;
    
    const mailOptions = {
      from: `"FEECENT" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
      to: email,
      subject: "FEECENT Password Reset Code",
      html: htmlContent,
      text: `Your FEECENT password reset code is: ${otp}. Valid for 10 minutes.`,
    };
    
    const info = await transporter.sendMail(mailOptions);
    console.log(`✅ Email sent to ${email}, Message ID: ${info.messageId}`);
    return true;
    
  } catch (error) {
    console.error("❌ Email error:", error.message);
    return false;
  }
}
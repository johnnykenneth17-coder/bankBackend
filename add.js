// ==================== EMAIL CONFIGURATION FOR BREVO FREE TIER ====================



// Simplified email sending function for Brevo
async function sendOTPEmail(email, otp) {
  console.log(`Attempting to send OTP ${otp} to ${email}`);
  
  // Check if we have required config
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.error("❌ SMTP credentials missing. Set SMTP_USER and SMTP_PASS");
    // Don't throw - just log and return
    return;
  }
  
  try {
    // Simplified HTML for better compatibility
    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="font-family: Arial, sans-serif; margin: 0; padding: 20px; background-color: #f5f5f5;">
        <div style="max-width: 500px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
          <div style="background: #6b21a8; padding: 20px; text-align: center;">
            <h1 style="color: white; margin: 0; font-size: 24px;">FEECENT</h1>
            <p style="color: #d8b4fe; margin: 5px 0 0;">Secure Digital Banking</p>
          </div>
          
          <div style="padding: 30px 20px;">
            <h2 style="color: #333; margin-top: 0;">Password Reset Request</h2>
            <p style="color: #666; line-height: 1.6;">We received a request to reset your password. Use the code below to continue:</p>
            
            <div style="background: #f8fafc; padding: 20px; text-align: center; margin: 25px 0; border-radius: 8px;">
              <div style="font-size: 42px; font-weight: bold; letter-spacing: 8px; color: #6b21a8; font-family: monospace;">
                ${otp}
              </div>
            </div>
            
            <p style="color: #666; font-size: 14px;">This code will expire in <strong>10 minutes</strong>.</p>
            <p style="color: #999; font-size: 12px; margin-top: 25px; padding-top: 15px; border-top: 1px solid #eee;">
              If you didn't request this, please ignore this email.
            </p>
          </div>
        </div>
      </body>
      </html>
    `;
    
    const mailOptions = {
      from: `"FEECENT" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
      to: email,
      subject: "🔐 FEECENT Password Reset Code",
      html: htmlContent,
      text: `Your FEECENT password reset code is: ${otp}. Valid for 10 minutes.`,
    };
    
    const info = await transporter.sendMail(mailOptions);
    console.log(`✅ Email sent to ${email}, Message ID: ${info.messageId}`);
    return true;
    
  } catch (error) {
    console.error("❌ Email error details:", {
      message: error.message,
      code: error.code,
      command: error.command,
      response: error.response,
    });
    
    // Don't throw - just return false
    return false;
  }
}

// SMS function (optional - can be simplified)
async function sendOTPSMS(phoneNumber, otp) {
  console.log(`📱 SMS would be sent to ${phoneNumber} with OTP ${otp}`);
  console.log("SMS service not configured - using email only");
  // For now, just log - SMS can be added later
  return;
}




// Step 1: Request OTP - SIMPLIFIED FOR BREVO
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

    // First, mark old OTPs as used
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

    // Send email - don't wait for it to complete (fire and forget for better performance)
    sendOTPEmail(normalizedEmail, otp).catch(err => {
      console.error("Background email send failed:", err);
    });

    // Return immediately without waiting for email
    res.json({ 
      message: "Reset code sent to your email. Check your inbox (and spam folder)." 
    });
    
  } catch (error) {
    console.error("Forgot password error:", error);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});
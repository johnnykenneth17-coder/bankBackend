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
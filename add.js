// Send email with OTP - WITH FALLBACK
let emailSent = false;
let emailError = null;

try {
  // Ensure we have a valid from address
  const fromAddress = process.env.SMTP_FROM || "noreply@feecent.com";
  
  const mailOptions = {
    from: fromAddress,
    to: normalizedEmail,
    subject: "Password Reset Code - FEECENT",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h2 style="color: #6b21a8;">FEECENT</h2>
          <h3 style="color: #333;">Password Reset Request</h3>
        </div>
        
        <div style="background: #f8fafc; padding: 20px; border-radius: 12px; text-align: center;">
          <p style="margin-bottom: 15px; color: #475569;">Your verification code is:</p>
          <div style="font-size: 36px; font-weight: bold; padding: 15px; background: white; border-radius: 8px; letter-spacing: 8px; color: #6b21a8; font-family: monospace;">
            ${otp}
          </div>
          <p style="margin-top: 15px; font-size: 14px; color: #64748b;">
            This code will expire in <strong>10 minutes</strong>.
          </p>
        </div>
        
        <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #e2e8f0;">
          <p style="font-size: 12px; color: #94a3b8; text-align: center;">
            If you didn't request this password reset, please ignore this email.
          </p>
        </div>
      </div>
    `,
  };
  
  // Send email with timeout
  const sendPromise = transporter.sendMail(mailOptions);
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("Email sending timeout")), 10000);
  });
  
  await Promise.race([sendPromise, timeoutPromise]);
  emailSent = true;
  console.log(`Reset email sent to ${normalizedEmail}`);
  
} catch (emailError) {
  console.error("Email sending error:", emailError);
  emailError = emailError.message;
  
  // Log the full error for debugging
  console.error("Full email error details:", JSON.stringify(emailError, null, 2));
}

// Even if email fails, return success to the user (don't reveal email issue)
// But log it for debugging
if (!emailSent) {
  console.warn(`Failed to send email to ${normalizedEmail}: ${emailError}`);
  // Still return success to the user to prevent email enumeration
  return res.json({ 
    success: true,
    message: "If your email is registered, you will receive a reset code.",
    debug: process.env.NODE_ENV === "development" ? `Email error: ${emailError}` : undefined
  });
}

res.json({ 
  success: true,
  message: "Reset code sent to your email" 
});
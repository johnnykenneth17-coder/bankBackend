// Enhanced sendOTPEmail function that supports different email types
async function sendOTPEmail(email, otp, type = 'reset') {
    console.log(`📧 Attempting to send ${type} email to ${email}${otp ? ` with OTP: ${otp}` : ''}`);

    // Check SMTP configuration
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
        console.error("❌ SMTP credentials missing. Email not sent.");
        return false;
    }

    try {
        let subject = '';
        let htmlContent = '';
        
        if (type === 'upgrade') {
            subject = 'FEECENT - Account Upgrade Verification';
            htmlContent = `
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="UTF-8">
                    <title>FEECENT Account Upgrade Verification</title>
                </head>
                <body style="font-family: Arial, sans-serif; margin: 0; padding: 20px; background: #f5f5f5;">
                    <div style="max-width: 500px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden;">
                        <div style="background: #6b21a8; padding: 20px; text-align: center;">
                            <h1 style="color: white; margin: 0;">FEECENT</h1>
                            <p style="color: #d8b4fe; margin: 5px 0 0;">Account Upgrade Verification</p>
                        </div>
                        <div style="padding: 30px 20px;">
                            <h2 style="color: #333; margin-top: 0;">Verify Your Email</h2>
                            <p style="color: #666;">You requested to upgrade your FEECENT account. Please use the verification code below to continue:</p>
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
        } else if (type === 'verified') {
            subject = 'FEECENT - Email Verified Successfully';
            htmlContent = `
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="UTF-8">
                    <title>Email Verified - FEECENT</title>
                </head>
                <body style="font-family: Arial, sans-serif; margin: 0; padding: 20px; background: #f5f5f5;">
                    <div style="max-width: 500px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden;">
                        <div style="background: #10b981; padding: 20px; text-align: center;">
                            <i class="fas fa-check-circle" style="font-size: 48px; color: white;"></i>
                            <h1 style="color: white; margin: 10px 0 0;">Email Verified!</h1>
                        </div>
                        <div style="padding: 30px 20px;">
                            <p style="color: #333; font-size: 16px;">Your email has been successfully verified.</p>
                            <p style="color: #666;">You can now proceed with your account upgrade by submitting your identification documents.</p>
                            <p style="color: #999; font-size: 12px; margin-top: 20px;">Thank you for choosing FEECENT.</p>
                        </div>
                    </div>
                </body>
                </html>
            `;
        } else {
            // Default password reset email
            subject = "FEECENT Password Reset Code";
            htmlContent = `
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="UTF-8">
                    <title>FEECENT Verification</title>
                </head>
                <body style="font-family: Arial, sans-serif; margin: 0; padding: 20px; background: #f5f5f5;">
                    <div style="max-width: 500px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden;">
                        <div style="background: #6b21a8; padding: 20px; text-align: center;">
                            <h1 style="color: white; margin: 0;">FEECENT</h1>
                            <p style="color: #d8b4fe; margin: 5px 0 0;">Password Reset</p>
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
        }

        const mailOptions = {
            from: `"FEECENT" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
            to: email,
            subject: subject,
            html: htmlContent,
            text: type === 'upgrade' ? `Your FEECENT account upgrade verification code is: ${otp}. Valid for 10 minutes.` : `Your FEECENT password reset code is: ${otp}. Valid for 10 minutes.`
        };

        const info = await transporter.sendMail(mailOptions);
        console.log(`✅ ${type} email sent to ${email}, Message ID: ${info.messageId}`);
        return true;
    } catch (error) {
        console.error(`❌ Email error (${type}):`, error.message);
        return false;
    }
}
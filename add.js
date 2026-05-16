




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
      return res.status(400).json({ error: "Code has expired" });
    }

    // Mark as used immediately
    const { error: updateError } = await supabase
      .from("password_resets")
      .update({ used: true })
      .eq("id", record.id);

    if (updateError) {
      console.error("Error marking OTP as used:", updateError);
    }

    console.log(`OTP verified successfully for ${normalizedEmail}`);
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
      return res.status(400).json({ error: "Reset session has expired" });
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

    console.log(`Password reset successfully for ${normalizedEmail}`);
    res.json({ message: "Password reset successful" });
    
  } catch (error) {
    console.error("Reset password error:", error);
    res.status(500).json({ error: "Failed to reset password" });
  }
});
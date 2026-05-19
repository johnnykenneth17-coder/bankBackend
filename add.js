// Resend passcode OTP - UPDATED to accept method parameter
app.post("/api/user/resend-passcode-otp", authenticate, async (req, res) => {
  try {
    const { request_id, method = "email" } = req.body;

    // Invalidate old request
    await supabase
      .from("passcode_otp_requests")
      .update({ is_used: true })
      .eq("id", request_id)
      .eq("user_id", req.user.id);

    // Get user
    const { data: user, error } = await supabase
      .from("users")
      .select("id, email, phone")
      .eq("id", req.user.id)
      .single();

    if (error) throw error;

    // Generate new OTP
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const newRequestId = uuidv4();

    const { data: otpRequest, error: insertError } = await supabase
      .from("passcode_otp_requests")
      .insert({
        id: newRequestId,
        user_id: req.user.id,
        otp_code: otpCode,
        expires_at: expiresAt,
        is_used: false,
      })
      .select()
      .single();

    if (insertError) throw insertError;

    // Send OTP based on requested method
    let sentMethod = "email";
    let contact = user.email;
    let sent = false;

    if (method === "sms" && user.phone && user.phone.trim()) {
      try {
        await sendOTPSMS(user.phone, otpCode);
        sent = true;
        sentMethod = "sms";
        contact = maskPhoneNumber(user.phone);
      } catch (smsError) {
        console.error("SMS send failed, falling back to email:", smsError);
        await sendOTPEmail(user.email, otpCode);
        sentMethod = "email";
        contact = maskEmail(user.email);
      }
    } else {
      await sendOTPEmail(user.email, otpCode);
      sentMethod = "email";
      contact = maskEmail(user.email);
    }

    res.json({
      success: true,
      request_id: newRequestId,
      method: sentMethod,
      contact: contact,
    });
  } catch (error) {
    console.error("Resend passcode OTP error:", error);
    res.status(500).json({ error: "Failed to resend code" });
  }
});
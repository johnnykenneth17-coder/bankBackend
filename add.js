// In your login endpoint, when returning user data, include admin_permissions
app.post("/api/auth/login", authLimiter, async (req, res) => {
  try {
    // ... existing login code ...
    
    // When returning user data, make sure to include admin_permissions
    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        role: user.role,
        admin_role: user.admin_role,
        admin_permissions: user.admin_permissions,  // ← CRITICAL: Include this
        is_frozen: user.is_frozen,
        kyc_status: user.kyc_status,
      },
      session: {
        id: sessionId,
        device: deviceInfo.device_name,
        logged_in_at: new Date().toISOString(),
      },
    });
  } catch (error) {
    // ...
  }
});
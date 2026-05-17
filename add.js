// Get user profile - Updated with all fields
app.get("/api/user/profile", authenticate, async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from("users")
      .select(`
        id,
        email,
        first_name,
        last_name,
        middle_name,
        phone,
        date_of_birth,
        age,
        gender,
        marital_status,
        occupation,
        referral_code,
        address,
        city,
        state,
        country,
        postal_code,
        identification_type,
        identification_number,
        kyc_status,
        two_factor_enabled,
        is_frozen,
        freeze_reason,
        face_verified,
        face_verification_date,
        created_at,
        updated_at
      `)
      .eq("id", req.user.id)
      .single();

    if (error) {
      console.error("Profile fetch error:", error);
      return res.status(500).json({ error: "Failed to fetch profile" });
    }

    // Get face descriptor count (for UI display)
    const { count: faceCount, error: faceCountError } = await supabase
      .from("face_descriptors")
      .select("*", { count: "exact", head: true })
      .eq("user_id", req.user.id)
      .eq("is_active", true);

    if (faceCountError) {
      console.error("Face count error:", faceCountError);
    }

    // Check if user has passcode set
    const { data: passcodeCheck, error: passcodeError } = await supabase
      .from("users")
      .select("passcode_hash")
      .eq("id", req.user.id)
      .single();

    const hasPasscode = passcodeCheck && passcodeCheck.passcode_hash !== null;

    console.log("Profile fetched for user:", user.id);
    console.log("Face verified:", user.face_verified);
    console.log("Has passcode:", hasPasscode);

    res.json({
      ...user,
      has_passcode: hasPasscode,
      face_descriptor_count: faceCount || 0,
    });
  } catch (error) {
    console.error("Profile fetch error:", error);
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});
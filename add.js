// Get user profile - Updated to return face image
app.get("/api/user/profile", authenticate, async (req, res) => {
    try {
        const { data: user, error } = await supabase
            .from("users")
            .select(
                "id, email, first_name, last_name, phone, date_of_birth, address, city, country, postal_code, kyc_status, two_factor_enabled, is_frozen, freeze_reason, face_image, created_at"
            )
            .eq("id", req.user.id)
            .single();

        if (error) throw error;

        console.log('Profile fetched for user:', user.id);
        console.log('Face image in profile:', user.face_image ? 'Yes' : 'No');

        res.json(user);
    } catch (error) {
        console.error("Profile fetch error:", error);
        res.status(500).json({ error: "Failed to fetch profile" });
    }
});
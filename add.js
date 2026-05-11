// Get push notification settings (FIXED)
app.get("/api/user/push-settings", authenticate, async (req, res) => {
  try {
    console.log("Fetching push settings for user:", req.user.id);
    
    // Try to get existing settings
    const { data: settings, error } = await supabase
      .from("user_push_settings")
      .select("*")
      .eq("user_id", req.user.id)
      .maybeSingle();

    if (error) {
      console.error("Fetch error:", error);
      // Return default settings
      return res.json({
        notifications_enabled: false,
        transfers: true,
        savings: true,
        security: true,
        promotions: false,
        bills: true
      });
    }

    // If settings exist, return them
    if (settings) {
      return res.json(settings);
    }

    // No settings found, create default and return
    console.log("No settings found, creating defaults");
    const defaultSettings = {
      user_id: req.user.id,
      notifications_enabled: false,
      transfers: true,
      savings: true,
      security: true,
      promotions: false,
      bills: true
    };

    const { data: newSettings, error: insertError } = await supabase
      .from("user_push_settings")
      .insert(defaultSettings)
      .select()
      .single();

    if (insertError) {
      console.error("Insert error:", insertError);
      // Return defaults anyway
      return res.json({
        notifications_enabled: false,
        transfers: true,
        savings: true,
        security: true,
        promotions: false,
        bills: true
      });
    }

    res.json(newSettings);
    
  } catch (error) {
    console.error("Push settings fetch error:", error);
    // Always return default settings to avoid breaking the UI
    res.json({
      notifications_enabled: false,
      transfers: true,
      savings: true,
      security: true,
      promotions: false,
      bills: true
    });
  }
});
// Register push token - FIXED VERSION
app.post("/api/user/register-push-token", authenticate, async (req, res) => {
  try {
    const { push_token, platform, device_name } = req.body;
    
    console.log("=== REGISTER PUSH TOKEN ===");
    console.log("User ID:", req.user.id);
    console.log("Platform:", platform);
    console.log("Token length:", push_token?.length);
    
    if (!push_token) {
      return res.status(400).json({ error: "Push token is required" });
    }
    
    // First, check if token already exists and reactivate it
    const { data: existingToken } = await supabase
      .from("user_push_tokens")
      .select("id")
      .eq("user_id", req.user.id)
      .eq("push_token", push_token)
      .maybeSingle();
    
    if (existingToken) {
      // Reactivate existing token
      const { error: updateError } = await supabase
        .from("user_push_tokens")
        .update({ 
          is_active: true, 
          last_active: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq("id", existingToken.id);
      
      if (updateError) {
        console.error("Update error:", updateError);
      }
    } else {
      // Insert new token
      const { error: insertError } = await supabase
        .from("user_push_tokens")
        .insert({
          user_id: req.user.id,
          push_token: push_token,
          platform: platform || "android",
          device_name: device_name || null,
          is_active: true,
          last_active: new Date().toISOString(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });
      
      if (insertError) {
        console.error("Insert error:", insertError);
        // Check if it's a duplicate key error
        if (insertError.code === "23505") {
          // Duplicate - try to reactivate instead
          const { error: reactivateError } = await supabase
            .from("user_push_tokens")
            .update({ 
              is_active: true, 
              last_active: new Date().toISOString(),
              updated_at: new Date().toISOString()
            })
            .eq("user_id", req.user.id)
            .eq("push_token", push_token);
          
          if (reactivateError) {
            console.error("Reactivate error:", reactivateError);
          }
        } else {
          return res.status(500).json({ error: "Failed to register push token: " + insertError.message });
        }
      }
    }
    
    // Also ensure push settings exist
    const { data: existingSettings } = await supabase
      .from("user_push_settings")
      .select("id")
      .eq("user_id", req.user.id)
      .maybeSingle();
    
    if (!existingSettings) {
      await supabase
        .from("user_push_settings")
        .insert({
          user_id: req.user.id,
          notifications_enabled: true,
          transfers: true,
          savings: true,
          security: true,
          promotions: false,
          bills: true,
          updated_at: new Date().toISOString()
        });
    } else {
      // Update notifications_enabled to true since they're registering
      await supabase
        .from("user_push_settings")
        .update({ 
          notifications_enabled: true,
          updated_at: new Date().toISOString()
        })
        .eq("user_id", req.user.id);
    }
    
    console.log("Push token registered successfully for user:", req.user.id);
    res.json({ 
      success: true, 
      message: "Push token registered successfully" 
    });
    
  } catch (error) {
    console.error("Push token registration error:", error);
    res.status(500).json({ error: "Failed to register push token: " + error.message });
  }
});
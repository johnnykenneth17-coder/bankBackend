// Update user (admin) - Ensure this properly handles admin_permissions
app.put("/api/admin/users/:userId", authenticate, authorizeAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const updates = req.body;
    
    // Remove sensitive fields
    delete updates.password_hash;
    delete updates.id;
    delete updates.created_at;
    
    // Handle admin_permissions as JSONB
    if (updates.admin_permissions) {
      updates.admin_permissions = JSON.stringify(updates.admin_permissions);
    }
    
    // Add timestamp
    updates.updated_at = new Date();
    
    const { data: user, error } = await supabase
      .from("users")
      .update(updates)
      .eq("id", userId)
      .select()
      .single();
      
    if (error) throw error;
    
    // Log admin action
    await supabase.from("admin_actions").insert({
      admin_id: req.user.id,
      action_type: "update_user",
      target_user_id: userId,
      details: updates,
    });
    
    res.json({ message: "User updated successfully", user });
  } catch (error) {
    console.error("Admin update user error:", error);
    res.status(500).json({ error: "Failed to update user" });
  }
});
// ==================== PUSH NOTIFICATION SETTINGS ROUTES ====================







// Delete push token (when user logs out)
app.delete("/api/user/push-token", authenticate, async (req, res) => {
  try {
    const { push_token } = req.body;

    if (push_token) {
      await supabase
        .from("user_push_tokens")
        .update({ is_active: false })
        .eq("user_id", req.user.id)
        .eq("push_token", push_token);
    } else {
      // Deactivate all tokens for this user
      await supabase
        .from("user_push_tokens")
        .update({ is_active: false })
        .eq("user_id", req.user.id);
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Push token deletion error:", error);
    res.status(500).json({ error: "Failed to delete push token" });
  }
});
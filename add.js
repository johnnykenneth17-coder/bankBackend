// ==================== PUSH NOTIFICATION ROUTES ====================



// Test endpoint to send a push notification (for testing)
app.post("/api/user/test-push", authenticate, async (req, res) => {
    try {
        // Get user's push tokens
        const { data: tokens, error } = await supabase
            .from("user_push_tokens")
            .select("push_token")
            .eq("user_id", req.user.id)
            .eq("is_active", true);
        
        if (error) throw error;
        
        if (!tokens || tokens.length === 0) {
            return res.json({ success: false, message: "No push tokens found" });
        }
        
        // Send test notification to all tokens
        const results = [];
        for (const token of tokens) {
            const sent = await sendPushNotification(
                token.push_token,
                "Test Notification",
                "This is a test push notification from Paystora!",
                { url: "/dashboard.html", type: "test" }
            );
            results.push({ sent });
        }
        
        res.json({ 
            success: true, 
            message: `Test notification sent to ${results.length} device(s)`,
            results 
        });
        
    } catch (error) {
        console.error("Test push error:", error);
        res.status(500).json({ error: "Failed to send test notification" });
    }
});
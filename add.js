// Send push to specific user via OneSignal
app.post("/api/notifications/send-push", authenticate, authorizeAdmin, async (req, res) => {
    try {
        const { user_id, title, message, data } = req.body;
        
        // Get user's OneSignal player ID
        const { data: tokens } = await supabase
            .from("user_push_tokens")
            .select("push_token")
            .eq("user_id", user_id)
            .eq("platform", "onesignal")
            .eq("is_active", true);
        
        if (!tokens || tokens.length === 0) {
            return res.json({ success: false, message: "No push token found" });
        }
        
        const playerIds = tokens.map(t => t.push_token);
        
        // Send via OneSignal API
        const response = await fetch("https://onesignal.com/api/v1/notifications", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Basic ${process.env.ONESIGNAL_REST_API_KEY}`
            },
            body: JSON.stringify({
                app_id: process.env.ONESIGNAL_APP_ID,
                headings: { en: title },
                contents: { en: message },
                include_player_ids: playerIds,
                data: data || {},
                priority: 10
            })
        });
        
        const result = await response.json();
        res.json({ success: result.id, notification_id: result.id });
        
    } catch (error) {
        console.error("Push send error:", error);
        res.status(500).json({ error: error.message });
    }
});
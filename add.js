// Check session validity endpoint
app.get("/api/auth/check-session", authenticate, async (req, res) => {
    try {
        const token = req.headers.authorization?.split(" ")[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        if (!decoded.sessionId) {
            return res.json({ 
                valid: false, 
                reason: "Old session format",
                code: "SESSION_EXPIRED" 
            });
        }

        const { valid, reason, code, device_name } = await checkSessionValidity(
            req.user.id,
            decoded.sessionId,
            token
        );

        if (!valid) {
            return res.json({ 
                valid: false, 
                reason: reason,
                code: code,
                device_name: device_name
            });
        }

        res.json({ valid: true });
    } catch (error) {
        console.error("Session check error:", error);
        res.json({ valid: true });
    }
});
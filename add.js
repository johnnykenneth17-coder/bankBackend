// In auth.js - Make sure this is correct
const authenticate = async (req, res, next) => {
    try {
        const authHeader = req.header('Authorization');
        console.log("Auth header:", authHeader ? "Present" : "Missing");
        
        const token = authHeader?.replace('Bearer ', '');
        
        if (!token) {
            console.log("No token provided");
            return res.status(401).json({ error: 'Please authenticate' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        console.log("Token decoded for user:", decoded.userId);
        
        const { data: user, error } = await supabase
            .from('users')
            .select('*')
            .eq('id', decoded.userId)
            .single();

        if (error || !user) {
            console.log("User not found:", error);
            return res.status(401).json({ error: 'User not found' });
        }
        
        if (!user.is_active) {
            console.log("User inactive:", user.id);
            return res.status(401).json({ error: 'Account is deactivated' });
        }

        req.user = user;
        req.token = token;
        next();
    } catch (error) {
        console.error("Authentication error:", error.message);
        res.status(401).json({ error: 'Please authenticate' });
    }
};
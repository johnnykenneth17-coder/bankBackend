// In auth.js - Make sure password_hash is selected
const authenticate = async (req, res, next) => {
    try {
        const token = req.header('Authorization')?.replace('Bearer ', '');
        
        if (!token) {
            throw new Error();
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        
        // IMPORTANT: Select password_hash here
        const { data: user, error } = await supabase
            .from('users')
            .select('id, email, first_name, last_name, role, is_active, is_frozen, freeze_reason, password_hash, phone, kyc_status')
            .eq('id', decoded.userId)
            .single();

        if (error || !user || !user.is_active) {
            throw new Error();
        }

        req.user = user;
        req.token = token;
        next();
    } catch (error) {
        res.status(401).json({ error: 'Please authenticate' });
    }
};
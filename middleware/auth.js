const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// Authentication middleware
const authenticate = async (req, res, next) => {
    try {
        const token = req.header('Authorization')?.replace('Bearer ', '');
        
        if (!token) {
            throw new Error();
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const { data: user, error } = await supabase
            .from('users')
            .select('*')
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

// Admin authorization middleware
const authorizeAdmin = async (req, res, next) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied. Admin only.' });
    }
    next();
};

// Check if account is frozen
const checkAccountFrozen = async (req, res, next) => {
    if (req.user.is_frozen) {
        return res.status(403).json({ 
            error: 'Account frozen',
            freeze_reason: req.user.freeze_reason,
            canContact: true
        });
    }
    next();
};

// Log admin actions
const logAdminAction = async (req, res, next) => {
    const originalJson = res.json;
    res.json = function(data) {
        if (req.user && req.user.role === 'admin') {
            const { data: actionData, error } = supabase
                .from('admin_actions')
                .insert({
                    admin_id: req.user.id,
                    action_type: req.route ? req.route.path : 'unknown',
                    target_user_id: req.params.userId || req.body.userId,
                    details: {
                        method: req.method,
                        body: req.body,
                        params: req.params,
                        query: req.query
                    },
                    ip_address: req.ip
                });
        }
        originalJson.call(this, data);
    };
    next();
};

// Rate limiting for OTP requests
const otpRateLimiter = require('express-rate-limit')({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // 5 requests per window
    message: { error: 'Too many OTP requests, please try again later' }
});

module.exports = {
    authenticate,
    authorizeAdmin,
    checkAccountFrozen,
    logAdminAction,
    otpRateLimiter
};
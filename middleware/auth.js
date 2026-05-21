const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const crypto = require('crypto');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// Authentication middleware
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

// ==================== TRANSACTION LOCKING MIDDLEWARE ====================

// Helper function to release lock
async function releaseLock(userId, requestId) {
    try {
        await supabase.rpc('release_transfer_lock', { 
            p_user_id: userId, 
            p_request_id: requestId 
        });
        console.log(`Lock released for user ${userId}`);
    } catch (error) {
        console.error("Error releasing lock:", error);
    }
}

// Middleware to prevent concurrent transfers
const preventConcurrentTransfer = async (req, res, next) => {
    try {
        const userId = req.user.id;
        
        // Generate unique request ID for this transaction attempt
        const requestId = crypto.randomUUID();
        
        // Check if user is already locked
        const { data: lockStatus, error: lockError } = await supabase
            .rpc('is_user_locked', { p_user_id: userId });
        
        if (lockError) {
            console.error("Lock check error:", lockError);
            // Continue anyway but log error
            return next();
        }
        
        if (lockStatus) {
            return res.status(409).json({ 
                error: "Another transaction is already in progress. Please wait a moment and try again.",
                code: "TRANSACTION_LOCKED",
                retry_after: 5
            });
        }
        
        // Try to acquire lock
        const { data: lockAcquired, error: acquireError } = await supabase
            .rpc('acquire_transfer_lock', { 
                p_user_id: userId, 
                p_request_id: requestId,
                p_lock_timeout_seconds: 30
            });
        
        if (acquireError) {
            console.error("Lock acquire error:", acquireError);
            // Continue anyway but log error
            return next();
        }
        
        if (!lockAcquired) {
            return res.status(409).json({ 
                error: "Unable to process transaction at this time. Please try again.",
                code: "TRANSACTION_BUSY"
            });
        }
        
        // Store request ID in request object for later release
        req.transactionLockId = requestId;
        req.userIdForLock = userId;
        
        next();
    } catch (error) {
        console.error("Lock middleware error:", error);
        // Continue without locking on error (better than blocking)
        next();
    }
};

// Middleware to release lock after request completes
const releaseTransactionLock = async (req, res, next) => {
    // Store original end function
    const originalEnd = res.end;
    const originalJson = res.json;
    const originalSend = res.send;
    
    // Override json method
    res.json = function(data) {
        // Call original with proper context
        originalJson.call(this, data);
        
        // Release lock after response
        if (req.transactionLockId && req.userIdForLock) {
            releaseLock(req.userIdForLock, req.transactionLockId);
        }
    };
    
    // Override send method
    res.send = function(data) {
        originalSend.call(this, data);
        
        if (req.transactionLockId && req.userIdForLock) {
            releaseLock(req.userIdForLock, req.transactionLockId);
        }
    };
    
    // Override end method
    res.end = function() {
        originalEnd.apply(this, arguments);
        
        if (req.transactionLockId && req.userIdForLock) {
            releaseLock(req.userIdForLock, req.transactionLockId);
        }
    };
    
    next();
};

// Cleanup expired locks periodically (run every minute)
// Note: This should ideally be in your main index.js, but can be here
let cleanupInterval = null;

const startLockCleanup = () => {
    if (cleanupInterval) return;
    cleanupInterval = setInterval(async () => {
        try {
            await supabase.rpc('cleanup_expired_locks');
            console.log("Expired locks cleaned up");
        } catch (error) {
            console.error("Lock cleanup error:", error);
        }
    }, 60000); // Run every minute
};

module.exports = {
    authenticate,
    authorizeAdmin,
    checkAccountFrozen,
    logAdminAction,
    otpRateLimiter,
    preventConcurrentTransfer,  // ← Add this
    releaseTransactionLock,      // ← Add this
    startLockCleanup             
};
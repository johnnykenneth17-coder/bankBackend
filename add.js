// Import the middleware
const {
    authenticate,
    authorizeAdmin,
    checkAccountFrozen,
    logAdminAction,
    otpRateLimiter,
    preventConcurrentTransfer,  // ← Add this
    releaseTransactionLock,      // ← Add this
    startLockCleanup             // ← Add this
} = require('../middleware/auth');

// Start the lock cleanup (add this after your app initialization)
startLockCleanup();

// Apply to transfer route - ORDER MATTERS!
app.post(
    "/api/user/transfer",
    authenticate,                    // 1. Authenticate first
    checkAccountFrozen,              // 2. Check if account is frozen
    preventConcurrentTransfer,       // 3. Acquire lock (prevents concurrent)
    releaseTransactionLock,          // 4. Ensures lock is released
    transferLimiter,                 // 5. Rate limit
    async (req, res) => {
        // Your existing transfer code here
    }
);
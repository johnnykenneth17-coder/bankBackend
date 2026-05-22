const jwt = require("jsonwebtoken");
const { createClient } = require("@supabase/supabase-js");

const crypto = require("crypto");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

// Authentication middleware
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.header("Authorization");
    console.log("Auth header:", authHeader ? "Present" : "Missing");

    const token = authHeader?.replace("Bearer ", "");

    if (!token) {
      console.log("No token provided");
      return res.status(401).json({ error: "Please authenticate" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    console.log("Token decoded for user:", decoded.userId);

    const { data: user, error } = await supabase
      .from("users")
      .select("*")
      .eq("id", decoded.userId)
      .single();

    if (error || !user) {
      console.log("User not found:", error);
      return res.status(401).json({ error: "User not found" });
    }

    if (!user.is_active) {
      console.log("User inactive:", user.id);
      return res.status(401).json({ error: "Account is deactivated" });
    }

    req.user = user;
    req.token = token;
    next();
  } catch (error) {
    console.error("Authentication error:", error.message);
    res.status(401).json({ error: "Please authenticate" });
  }
};

// Admin authorization middleware
const authorizeAdmin = async (req, res, next) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Access denied. Admin only." });
  }
  next();
};

// Check if account is frozen
const checkAccountFrozen = async (req, res, next) => {
  if (req.user.is_frozen) {
    return res.status(403).json({
      error: "Account frozen",
      freeze_reason: req.user.freeze_reason,
      canContact: true,
    });
  }
  next();
};

// Log admin actions
const logAdminAction = async (req, res, next) => {
  const originalJson = res.json;
  res.json = function (data) {
    if (req.user && req.user.role === "admin") {
      const { data: actionData, error } = supabase
        .from("admin_actions")
        .insert({
          admin_id: req.user.id,
          action_type: req.route ? req.route.path : "unknown",
          target_user_id: req.params.userId || req.body.userId,
          details: {
            method: req.method,
            body: req.body,
            params: req.params,
            query: req.query,
          },
          ip_address: req.ip,
        });
    }
    originalJson.call(this, data);
  };
  next();
};

// Rate limiting for OTP requests
const otpRateLimiter = require("express-rate-limit")({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 requests per window
  message: { error: "Too many OTP requests, please try again later" },
});

// ==================== TRANSACTION LOCKING MIDDLEWARE ====================

// Helper function to release lock
async function releaseLock(userId, requestId) {
  try {
    await supabase.rpc("release_transfer_lock", {
      p_user_id: userId,
      p_request_id: requestId,
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
    const { data: lockStatus, error: lockError } = await supabase.rpc(
      "is_user_locked",
      { p_user_id: userId },
    );

    if (lockError) {
      console.error("Lock check error:", lockError);
      // Continue anyway but log error
      return next();
    }

    if (lockStatus) {
      return res.status(409).json({
        error:
          "Another transaction is already in progress. Please wait a moment and try again.",
        code: "TRANSACTION_LOCKED",
        retry_after: 5,
      });
    }

    // Try to acquire lock
    const { data: lockAcquired, error: acquireError } = await supabase.rpc(
      "acquire_transfer_lock",
      {
        p_user_id: userId,
        p_request_id: requestId,
        p_lock_timeout_seconds: 30,
      },
    );

    if (acquireError) {
      console.error("Lock acquire error:", acquireError);
      // Continue anyway but log error
      return next();
    }

    if (!lockAcquired) {
      return res.status(409).json({
        error: "Unable to process transaction at this time. Please try again.",
        code: "TRANSACTION_BUSY",
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
  res.json = function (data) {
    // Call original with proper context
    originalJson.call(this, data);

    // Release lock after response
    if (req.transactionLockId && req.userIdForLock) {
      releaseLock(req.userIdForLock, req.transactionLockId);
    }
  };

  // Override send method
  res.send = function (data) {
    originalSend.call(this, data);

    if (req.transactionLockId && req.userIdForLock) {
      releaseLock(req.userIdForLock, req.transactionLockId);
    }
  };

  // Override end method
  res.end = function () {
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
      await supabase.rpc("cleanup_expired_locks");
      console.log("Expired locks cleaned up");
    } catch (error) {
      console.error("Lock cleanup error:", error);
    }
  }, 60000); // Run every minute
};

// Add these functions to auth.js

// Generate unique session ID
function generateSessionId() {
  return crypto.randomBytes(32).toString("hex");
}

// Generate unique session ID
/*function generateSessionId(userId) {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomBytes(16).toString("hex");
  const version = Date.now();
  return `${userId.substring(0, 8)}_${timestamp}_${random}_${version}`;
}*/

// Get device info for tracking
function getDeviceInfo(req) {
  const userAgent = req.headers["user-agent"] || "Unknown";
  const ip =
    req.ip ||
    req.connection?.remoteAddress ||
    req.headers["x-forwarded-for"] ||
    "Unknown";

  let deviceType = "Unknown";
  let browser = "Unknown";
  let os = "Unknown";

  if (userAgent.includes("Mobile")) deviceType = "Mobile";
  else if (userAgent.includes("Tablet")) deviceType = "Tablet";
  else deviceType = "Desktop";

  if (userAgent.includes("Chrome")) browser = "Chrome";
  else if (userAgent.includes("Firefox")) browser = "Firefox";
  else if (userAgent.includes("Safari")) browser = "Safari";
  else if (userAgent.includes("Edge")) browser = "Edge";

  if (userAgent.includes("Windows")) os = "Windows";
  else if (userAgent.includes("Mac")) os = "macOS";
  else if (userAgent.includes("Linux")) os = "Linux";
  else if (userAgent.includes("Android")) os = "Android";
  else if (userAgent.includes("iOS")) os = "iOS";

  return {
    device_name: `${deviceType} - ${browser} on ${os}`,
    ip_address: ip,
    user_agent: userAgent,
    device_type: deviceType,
    browser: browser,
    os: os,
  };
}

// ==================== FIXED: PROFESSIONAL SESSION VALIDATION ====================

/*async function checkSessionValidity(userId, sessionId, token) {
  try {
    console.log(
      `[Session Check] Checking validity for user: ${userId}, sessionId: ${sessionId}`,
    );

    // Get the user's current active session from database
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("active_session_id, last_active_device, is_active, is_frozen")
      .eq("id", userId)
      .single();

    if (userError) {
      console.error("[Session Check] User fetch error:", userError);
      return { valid: true }; // Assume valid on error to avoid false logouts
    }

    if (!user) {
      console.error("[Session Check] User not found:", userId);
      return { valid: false, reason: "User not found", code: "USER_NOT_FOUND" };
    }

    console.log(
      `[Session Check] User.active_session_id: ${user.active_session_id}`,
    );
    console.log(`[Session Check] Request sessionId: ${sessionId}`);

    // CRITICAL: If token has NO sessionId (old token format), force re-login
    if (!sessionId) {
      console.log("[Session Check] No sessionId in token - forcing re-login");
      return {
        valid: false,
        reason: "Session expired. Please log in again.",
        code: "SESSION_EXPIRED",
      };
    }

    // CRITICAL: If user has NO active_session_id in database, this session is invalid
    if (!user.active_session_id) {
      console.log(
        "[Session Check] User has no active session in DB - invalidating",
      );
      // Mark this token's session as inactive
      await supabase
        .from("user_sessions")
        .update({
          is_active: false,
          is_current: false,
          invalidated_reason: "No active session in user record",
          expires_at: new Date().toISOString(),
        })
        .eq("user_id", userId)
        .eq("session_id", sessionId);

      return {
        valid: false,
        reason: "Your session has expired. Please log in again.",
        code: "SESSION_EXPIRED",
      };
    }

    // CRITICAL: If session IDs don't match, another device logged in
    if (user.active_session_id !== sessionId) {
      console.log(
        `[Session Check] SESSION MISMATCH! Active: ${user.active_session_id}, Request: ${sessionId}`,
      );

      // Mark this session as inactive
      await supabase
        .from("user_sessions")
        .update({
          is_active: false,
          is_current: false,
          invalidated_reason: "New login from another device",
          expires_at: new Date().toISOString(),
        })
        .eq("user_id", userId)
        .eq("session_id", sessionId);

      return {
        valid: false,
        reason:
          "Your account was accessed from another device. This session has been terminated.",
        code: "SESSION_REPLACED",
        device_name: user.last_active_device || "Another device",
      };
    }

    // Session is valid - update last activity
    await supabase
      .from("user_sessions")
      .update({ last_activity: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("session_id", sessionId)
      .eq("is_active", true);

    console.log(`[Session Check] Session VALID for user ${userId}`);
    return { valid: true };
  } catch (error) {
    console.error("[Session Check] Error:", error);
    return { valid: true }; // Assume valid on error to prevent false logouts
  }
}*/

// ==================== FIXED: INVALIDATE ALL USER SESSIONS ====================

async function invalidateAllUserSessions(
  userId,
  reason = "New login from another device",
) {
  try {
    console.log(
      `[Session Invalidate] Invalidating all sessions for user: ${userId}`,
    );

    // Get all active sessions for logging
    const { data: oldSessions, error: fetchError } = await supabase
      .from("user_sessions")
      .select("id, session_id, device_name")
      .eq("user_id", userId)
      .eq("is_active", true);

    if (fetchError) {
      console.error("[Session Invalidate] Fetch error:", fetchError);
    }

    if (oldSessions && oldSessions.length > 0) {
      console.log(
        `[Session Invalidate] Found ${oldSessions.length} active session(s) to invalidate`,
      );

      // Invalidate ALL sessions
      const { error: updateError } = await supabase
        .from("user_sessions")
        .update({
          is_active: false,
          is_current: false,
          invalidated_reason: reason,
          expires_at: new Date().toISOString(),
        })
        .eq("user_id", userId)
        .eq("is_active", true);

      if (updateError) {
        console.error("[Session Invalidate] Update error:", updateError);
      }

      // Create notifications for each old session's device
      for (const session of oldSessions) {
        await supabase
          .from("notifications")
          .insert({
            user_id: userId,
            title: "Session Terminated",
            message: `Your session on ${session.device_name || "another device"} was terminated due to a new login.`,
            type: "security",
            created_at: new Date().toISOString(),
          })
          .catch((e) => console.error("Notification error:", e));
      }
    }

    // Clear active_session_id from users table
    const { error: clearError } = await supabase
      .from("users")
      .update({
        active_session_id: null,
        active_session_started_at: null,
      })
      .eq("id", userId);

    if (clearError) {
      console.error("[Session Invalidate] Clear user error:", clearError);
    }

    console.log(
      `[Session Invalidate] Successfully invalidated ${oldSessions?.length || 0} session(s)`,
    );
    return oldSessions?.length || 0;
  } catch (error) {
    console.error("[Session Invalidate] Error:", error);
    return 0;
  }
}

// ==================== FIXED: CREATE USER SESSION ====================

async function createUserSession(userId, token, deviceInfo) {
  try {
    console.log(`[Create Session] Creating new session for user: ${userId}`);

    const sessionId = generateSessionId();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7); // 7 days expiry

    // FIRST: Invalidate ALL existing sessions for this user
    await invalidateAllUserSessions(userId, "New login from another device");

    // SECOND: Insert new session
    const { data: session, error: sessionError } = await supabase
      .from("user_sessions")
      .insert({
        user_id: userId,
        session_token: token,
        session_id: sessionId,
        device_fingerprint: deviceInfo.device_name,
        device_name: deviceInfo.device_name,
        ip_address: deviceInfo.ip_address,
        user_agent: deviceInfo.user_agent,
        expires_at: expiresAt.toISOString(),
        is_active: true,
        is_current: true,
        created_at: new Date().toISOString(),
        last_activity: new Date().toISOString(),
      })
      .select()
      .single();

    if (sessionError) {
      console.error("[Create Session] Insert error:", sessionError);
      throw sessionError;
    }

    // THIRD: Update user's active session
    const { error: updateError } = await supabase
      .from("users")
      .update({
        active_session_id: sessionId,
        last_active_device: deviceInfo.device_name,
        active_session_started_at: new Date().toISOString(),
        last_login: new Date().toISOString(),
      })
      .eq("id", userId);

    if (updateError) {
      console.error("[Create Session] Update user error:", updateError);
    }

    console.log(`[Create Session] Session created successfully: ${sessionId}`);
    return { sessionId, session };
  } catch (error) {
    console.error("[Create Session] Error:", error);
    throw error;
  }
}

// ==================== FIXED: MIDDLEWARE - Check Single Device Session ====================

const checkSingleDeviceSession = async (req, res, next) => {
  try {
    const authHeader = req.header("Authorization");
    const token = authHeader?.replace("Bearer ", "");

    if (!token) {
      console.log("[Session Middleware] No token provided");
      return res.status(401).json({ error: "Please authenticate" });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (jwtError) {
      console.log(
        "[Session Middleware] JWT verification failed:",
        jwtError.message,
      );
      return res.status(401).json({ error: "Invalid token" });
    }

    console.log(
      `[Session Middleware] Checking session for user: ${decoded.userId}`,
    );

    // Get user with active session
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("id, active_session_id, is_active, is_frozen, last_active_device")
      .eq("id", decoded.userId)
      .single();

    if (userError || !user) {
      console.log("[Session Middleware] User not found:", userError);
      return res.status(401).json({ error: "User not found" });
    }

    // Check if user is active
    if (!user.is_active) {
      return res.status(401).json({ error: "Account deactivated" });
    }

    // CRITICAL: Check if this token's session ID matches the active session
    if (decoded.sessionId) {
      if (
        user.active_session_id &&
        user.active_session_id !== decoded.sessionId
      ) {
        console.log(
          `[Session Middleware] SESSION MISMATCH! Active: ${user.active_session_id}, Token: ${decoded.sessionId}`,
        );

        // Mark this session as inactive
        await supabase
          .from("user_sessions")
          .update({
            is_active: false,
            is_current: false,
            invalidated_reason: "New login from another device",
          })
          .eq("session_token", token);

        return res.status(401).json({
          error: "session_expired",
          message:
            "You have been logged out because a new login was detected on another device.",
          code: "SESSION_REPLACED",
          device_name: user.last_active_device || "Another device",
        });
      }
    } else if (user.active_session_id) {
      // Old token without session ID - invalidate it
      console.log("[Session Middleware] Old token without session ID");
      return res.status(401).json({
        error: "session_expired",
        message: "Your session has expired. Please log in again.",
        code: "SESSION_EXPIRED",
      });
    }

    // Update last activity
    await supabase
      .from("user_sessions")
      .update({ last_activity: new Date().toISOString() })
      .eq("session_token", token)
      .eq("is_active", true);

    req.user = user;
    req.token = token;
    req.sessionId = decoded.sessionId;
    next();
  } catch (error) {
    console.error("[Session Middleware] Error:", error.message);
    res.status(401).json({ error: "Please authenticate" });
  }
};

 async function checkSessionValidity(userId, sessionId, token) {
    try {
        // First, get the user's current active session
        const { data: user, error: userError } = await supabase
            .from("users")
            .select("active_session_id, last_active_device")
            .eq("id", userId)
            .single();

        if (userError) {
            console.error("User fetch error:", userError);
            return { valid: true }; // Assume valid on error
        }

        // If user has no active session, this is a new login - allow it
        if (!user.active_session_id) {
            return { valid: true };
        }

        // If this token doesn't have sessionId (old token format)
        if (!sessionId) {
            return { 
                valid: false, 
                reason: "Session format invalid. Please log in again.",
                code: "SESSION_EXPIRED"
            };
        }

        // If session IDs don't match, another device logged in
        if (user.active_session_id !== sessionId) {
            // Mark this session as inactive
            await supabase
                .from("user_sessions")
                .update({
                    is_active: false,
                    invalidated_reason: "New login from another device",
                    expires_at: new Date().toISOString()
                })
                .eq("user_id", userId)
                .eq("session_id", sessionId)
                .eq("is_active", true);

            return { 
                valid: false, 
                reason: "Another device logged in",
                code: "SESSION_REPLACED",
                device_name: user.last_active_device || "Another device"
            };
        }

        return { valid: true };
    } catch (error) {
        console.error("Check session validity error:", error);
        return { valid: true }; // Assume valid on error
    }
} 

// ==================== FIXED: GET USER ACTIVE SESSIONS ====================

async function getUserActiveSessions(userId) {
  try {
    const { data: sessions, error } = await supabase
      .from("user_sessions")
      .select(
        "id, session_id, device_fingerprint, ip_address, user_agent, created_at, last_activity, is_current, device_name",
      )
      .eq("user_id", userId)
      .eq("is_active", true)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("[Get Sessions] Error:", error);
      return [];
    }

    return sessions || [];
  } catch (error) {
    console.error("[Get Sessions] Error:", error);
    return [];
  }
}

// ==================== FIXED: REVOKE SPECIFIC SESSION ====================

async function revokeSession(sessionId, userId, reason = "User initiated") {
  try {
    const { error } = await supabase
      .from("user_sessions")
      .update({
        is_active: false,
        is_current: false,
        invalidated_reason: reason,
        expires_at: new Date().toISOString(),
      })
      .eq("id", sessionId)
      .eq("user_id", userId);

    if (error) throw error;

    // If this was the active session, clear it from user record
    const { data: user } = await supabase
      .from("users")
      .select("active_session_id")
      .eq("id", userId)
      .single();

    if (user?.active_session_id === sessionId) {
      await supabase
        .from("users")
        .update({ active_session_id: null })
        .eq("id", userId);
    }

    return true;
  } catch (error) {
    console.error("[Revoke Session] Error:", error);
    return false;
  }
}

// ==================== FIXED: REVOKE CURRENT SESSION (LOGOUT) ====================

async function revokeCurrentSession(userId, sessionId, token) {
  try {
    console.log(
      `[Revoke Current] Revoking session for user: ${userId}, sessionId: ${sessionId}`,
    );

    // Update session to inactive
    const { error: sessionError } = await supabase
      .from("user_sessions")
      .update({
        is_active: false,
        is_current: false,
        invalidated_reason: "User logged out",
        expires_at: new Date().toISOString(),
      })
      .eq("user_id", userId)
      .eq("session_id", sessionId);

    if (sessionError) {
      console.error("[Revoke Current] Session update error:", sessionError);
    }

    // Clear user's active session if it matches
    await supabase
      .from("users")
      .update({
        active_session_id: null,
        active_session_started_at: null,
      })
      .eq("id", userId)
      .eq("active_session_id", sessionId);

    console.log(`[Revoke Current] Session revoked successfully`);
    return true;
  } catch (error) {
    console.error("[Revoke Current] Error:", error);
    return false;
  }
}

// Export new functions
module.exports = {
  authenticate,
  authorizeAdmin,
  checkAccountFrozen,
  logAdminAction,
  otpRateLimiter,
  preventConcurrentTransfer,
  releaseTransactionLock,
  startLockCleanup,
  generateSessionId, // Add this
  getDeviceInfo,
  invalidateAllUserSessions,
  checkSingleDeviceSession, // Add this
  createUserSession,
  checkSessionValidity, // Add this
  getUserActiveSessions, // Add this
  revokeSession,
  revokeCurrentSession, // Add this
  generateSessionId,
};

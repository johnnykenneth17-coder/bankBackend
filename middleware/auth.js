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
/*function generateSessionId() {
  return crypto.randomBytes(32).toString("hex");
}*/

// Generate unique session ID
function generateSessionId(userId) {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomBytes(16).toString("hex");
  const version = Date.now();
  return `${userId.substring(0, 8)}_${timestamp}_${random}_${version}`;
}

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

// INVALIDATE ALL SESSIONS for a user (called before login)
async function invalidateAllUserSessions(
  userId,
  reason = "New login from another device",
) {
  try {
    // Get all active sessions for logging
    const { data: oldSessions } = await supabase
      .from("user_sessions")
      .select("id, session_id, device_name")
      .eq("user_id", userId)
      .eq("is_active", true);

    if (oldSessions && oldSessions.length > 0) {
      console.log(
        `Invalidating ${oldSessions.length} old session(s) for user ${userId}`,
      );

      // Invalidate all sessions
      const { error } = await supabase
        .from("user_sessions")
        .update({
          is_active: false,
          is_current: false,
          invalidated_reason: reason,
          expires_at: new Date().toISOString(),
        })
        .eq("user_id", userId)
        .eq("is_active", true);

      if (error) {
        console.error("Failed to invalidate sessions:", error);
      }

      // Create notifications for old sessions (optional)
      for (const session of oldSessions) {
        await supabase.from("notifications").insert({
          user_id: userId,
          title: "Session Terminated",
          message: `Your session on ${session.device_name || "another device"} has been terminated due to a new login.`,
          type: "security",
          created_at: new Date().toISOString(),
        });
      }
    }

    // Clear active_session_id from users table
    await supabase
      .from("users")
      .update({
        active_session_id: null,
        session_version: supabase.raw("session_version + 1"),
      })
      .eq("id", userId);

    return oldSessions?.length || 0;
  } catch (error) {
    console.error("Invalidate sessions error:", error);
    return 0;
  }
}

// MIDDLEWARE: Check single device session
const checkSingleDeviceSession = async (req, res, next) => {
  try {
    const authHeader = req.header("Authorization");
    const token = authHeader?.replace("Bearer ", "");

    if (!token) {
      return res.status(401).json({ error: "Please authenticate" });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (jwtError) {
      return res.status(401).json({ error: "Invalid token" });
    }

    // If token doesn't have sessionId, it's an old token
    if (!decoded.sessionId) {
      return res.status(401).json({
        error: "session_expired",
        message: "Your session has expired. Please log in again.",
        code: "SESSION_EXPIRED",
      });
    }

    // Check session validity
    const { valid, reason, code, device_name } = await checkSessionValidity(
      decoded.userId,
      decoded.sessionId,
      token,
    );

    if (!valid) {
      return res.status(401).json({
        error: "session_expired",
        message: reason,
        code: code || "SESSION_INVALID",
        device_name: device_name,
      });
    }

    // Update last activity
    await supabase
      .from("user_sessions")
      .update({ last_activity: new Date().toISOString() })
      .eq("session_token", token)
      .eq("is_active", true);

    req.user = { id: decoded.userId, email: decoded.email, role: decoded.role };
    req.token = token;
    req.sessionId = decoded.sessionId;
    next();
  } catch (error) {
    console.error("Session check error:", error.message);
    res.status(401).json({ error: "Please authenticate" });
  }
};

// CREATE NEW SESSION
async function createUserSession(userId, token, deviceInfo, sessionVersion) {
  try {
    const sessionId = generateSessionId(userId);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7); // 7 days expiry

    // First, invalidate all old sessions
    await invalidateAllUserSessions(userId, "New login from another device");

    // Insert new session
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
        session_version: sessionVersion,
      })
      .select()
      .single();

    if (sessionError) {
      console.error("Session insert error:", sessionError);
      throw sessionError;
    }

    // Update user's active session
    await supabase
      .from("users")
      .update({
        active_session_id: sessionId,
        last_active_device: deviceInfo.device_name,
        active_session_started_at: new Date().toISOString(),
        last_login: new Date().toISOString(),
        session_version: sessionVersion,
      })
      .eq("id", userId);

    console.log(`New session created for user ${userId}: ${sessionId}`);
    return { sessionId, session };
  } catch (error) {
    console.error("Create session error:", error);
    throw error;
  }
}

// CHECK SESSION VALIDITY (returns true if valid, false with reason if not)
// auth.js - Replace the checkSessionValidity function with this

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

// Get all active sessions for a user
async function getUserActiveSessions(userId) {
  const { data: sessions, error } = await supabase
    .from("user_sessions")
    .select(
      "id, device_fingerprint, ip_address, user_agent, created_at, last_activity, is_current",
    )
    .eq("user_id", userId)
    .eq("is_active", true)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return sessions || [];
}

// Revoke specific session (for user-initiated logout from other devices)
async function revokeSession(sessionId, userId, reason = "User initiated") {
  const { error } = await supabase
    .from("user_sessions")
    .update({
      is_active: false,
      invalidated_reason: reason,
      expires_at: new Date(),
    })
    .eq("id", sessionId)
    .eq("user_id", userId);

  if (error) throw error;

  // If this was the active session, clear it from user record
  if (sessionId) {
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
  }

  return true;
}

// REVOKE CURRENT SESSION (logout)
async function revokeCurrentSession(userId, sessionId, token) {
  try {
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
      console.error("Session revoke error:", sessionError);
    }

    // Clear user's active session
    await supabase
      .from("users")
      .update({
        active_session_id: null,
        active_session_started_at: null,
      })
      .eq("id", userId);

    return true;
  } catch (error) {
    console.error("Revoke session error:", error);
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

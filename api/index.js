const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { createClient } = require("@supabase/supabase-js");
const speakeasy = require("speakeasy");
const QRCode = require("qrcode");
const { v4: uuidv4 } = require("uuid");
require("dotenv").config();
const router = express.Router();
const nodemailer = require("nodemailer");
const webpush = require("web-push");
const crypto = require("crypto");
const axios = require("axios");

// ONLY NOW declare app
const app = express();

const rateLimit = require("express-rate-limit");
//const helmet = require('helmet');

// Store failed attempts in memory (use Redis in production)
const failedAttempts = new Map();
const suspiciousActivities = new Map();

// Enhanced rate limiting
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: "Too many requests. Please try again later." },
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    return req.ip + (req.body.email || "");
  },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "Too many authentication attempts. Try again later." },
  skipSuccessfulRequests: true,
});

const transferLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { error: "Transfer limit reached. Try again later." },
});

// Enhanced security headers
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          "https://fonts.googleapis.com",
          "https://cdnjs.cloudflare.com",
        ],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          "'unsafe-eval'",
          "https://cdnjs.cloudflare.com",
          "https://cdn.jsdelivr.net",
        ],
        fontSrc: [
          "'self'",
          "https://fonts.gstatic.com",
          "https://cdnjs.cloudflare.com",
        ],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: [
          "'self'",
          "https://bank-backend-blush.vercel.app",
          "https://*.supabase.co",
        ],
        frameSrc: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: [],
      },
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
    noSniff: true,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  }),
);

// Security middleware FIRST (after app is declared)
//app.use(helmet());

// Then cors
app.use(
  cors({
    origin: (origin, callback) => {
      const allowed = [
        "http://127.0.0.1:5501",
        "http://localhost",
        "https://localhost",
        "http://localhost:5500",
        "http://127.0.0.1:5500",
        "https://zivarabank.vercel.app",
        "https://paystora.com",
        "www.paystora.com",
        "paystora.com",
        "*",
      ];
      if (
        !origin ||
        allowed.includes(origin) ||
        allowed.some((a) => origin?.startsWith(a))
      ) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization"],
    optionsSuccessStatus: 204,
  }),
);
app.use(express.json());
app.use(morgan("combined"));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || "http://localhost:8001";
const AI_SERVICE_API_KEY =
  process.env.AI_SERVICE_API_KEY || "face-auth-key-2024";

// Face verification state tracking (in production, use Redis)
const faceVerificationStates = new Map(); // session_id -> { user_id, timestamp, attempts }

// Configure VAPID for web push - ADD THIS SECTION
webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || "mailto:support@paystora.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY,
);

// Function to send push notification to user
async function sendPushNotificationToUser(userId, title, body, data = {}) {
  try {
    // Get user's push tokens
    const { data: tokens, error } = await supabase
      .from("user_push_tokens")
      .select("push_token, platform")
      .eq("user_id", userId)
      .eq("is_active", true);

    if (error || !tokens || tokens.length === 0) {
      console.log("No push tokens found for user:", userId);
      return false;
    }

    let sent = false;
    for (const token of tokens) {
      if (token.platform === "android" || token.platform === "ios") {
        // For native Android/iOS, you would send via FCM
        // This requires setting up a FCM server key
        // For now, store in notifications table
        sent = true;
      } else {
        // Web push
        const { webpush } = require("web-push");
        try {
          await webpush.sendNotification(
            JSON.parse(token.push_token),
            JSON.stringify({
              title,
              body,
              data,
              icon: "/icons/icon-192x192.png",
            }),
          );
          sent = true;
        } catch (err) {
          console.error("Web push error:", err);
        }
      }
    }

    return sent;
  } catch (error) {
    console.error("Send push error:", error);
    return false;
  }
}

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: process.env.SMTP_PORT == 465, // true for 465, false for other ports
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Create transporter with Brevo-specific settings
/*const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp-relay.brevo.com",
  port: parseInt(process.env.SMTP_PORT) || 587,
  secure: false, // Use TLS, not SSL (587 is TLS)
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: {
    rejectUnauthorized: false, // For Brevo free tier
  },
  connectionTimeout: 10000, // 10 seconds
  greetingTimeout: 10000,
  socketTimeout: 15000,
});*/

// Test transporter on startup (silent fail)
async function testEmailConfig() {
  try {
    await transporter.verify();
    console.log("✅ Brevo SMTP configured successfully");
  } catch (error) {
    console.error("⚠️ Brevo SMTP configuration error:", error.message);
    console.log("Email will still work - check your SMTP credentials");
  }
}
testEmailConfig();

// Send push notification to user's device when in-app notification is created
async function sendPushNotificationForInAppNotification(
  userId,
  title,
  message,
  notificationId,
  type = "info",
) {
  try {
    // Get user's push tokens
    const { data: tokens, error } = await supabase
      .from("user_push_tokens")
      .select("push_token, platform")
      .eq("user_id", userId)
      .eq("is_active", true);

    if (error || !tokens || tokens.length === 0) {
      console.log("No push tokens found for user:", userId);
      return false;
    }

    // Check if user has push notifications enabled
    const { data: settings } = await supabase
      .from("user_push_settings")
      .select(
        "notifications_enabled, transfers, savings, security, promotions, bills",
      )
      .eq("user_id", userId)
      .single();

    if (!settings || !settings.notifications_enabled) {
      console.log("Push notifications disabled for user:", userId);
      return false;
    }

    // Check if this notification type is enabled
    let typeEnabled = true;
    if (type === "transfer") typeEnabled = settings.transfers !== false;
    else if (type === "savings") typeEnabled = settings.savings !== false;
    else if (type === "security") typeEnabled = settings.security !== false;
    else if (type === "promotion") typeEnabled = settings.promotions === true;
    else if (type === "bill") typeEnabled = settings.bills !== false;

    if (!typeEnabled) {
      console.log(`Push type ${type} disabled for user:`, userId);
      return false;
    }

    // Prepare payload
    const payload = {
      title: title,
      body: message,
      data: {
        notificationId: notificationId,
        type: type,
        timestamp: new Date().toISOString(),
        url: "/dashboard.html",
      },
      icon: "/icons/icon-192x192.png",
      badge: "/icons/badge-72x72.png",
      vibrate: [200, 100, 200],
      sound: "default",
      priority: "high",
    };

    let sent = false;

    // Send to all active tokens
    for (const token of tokens) {
      try {
        if (token.platform === "android") {
          // For Capacitor Android, we need to send via FCM
          // The Capacitor PushNotifications plugin handles this automatically
          // We just need to store the notification
          console.log(
            "Android push token found, notification will be delivered by Capacitor",
          );
          sent = true;
        } else if (token.platform === "web") {
          // For web PWA
          try {
            const webpush = require("web-push");
            await webpush.sendNotification(
              JSON.parse(token.push_token),
              JSON.stringify(payload),
            );
            sent = true;
          } catch (err) {
            console.error("Web push error:", err);
          }
        } else {
          sent = true;
        }
      } catch (err) {
        console.error(`Push send error for token ${token.id}:`, err);
      }
    }

    return sent;
  } catch (error) {
    console.error("Send push notification error:", error);
    return false;
  }
}

// ==================== DEVICE TRUST & TRANSFER HISTORY ====================

// Track user's trusted devices
async function updateDeviceTrust(userId, deviceFingerprint, userAgent, ip) {
  try {
    // Check if device exists
    const { data: existingDevice } = await supabase
      .from("trusted_devices")
      .select("*")
      .eq("user_id", userId)
      .eq("device_fingerprint", deviceFingerprint)
      .single();

    const now = new Date().toISOString();

    if (existingDevice) {
      // Update last used timestamp
      await supabase
        .from("trusted_devices")
        .update({
          last_used_at: now,
          usage_count: (existingDevice.usage_count || 0) + 1,
          ip_address: ip,
          user_agent: userAgent,
        })
        .eq("id", existingDevice.id);

      return {
        isNewDevice: false,
        deviceAge: Math.floor(
          (Date.now() - new Date(existingDevice.first_seen_at)) /
            (1000 * 60 * 60 * 24),
        ),
        trustLevel: existingDevice.trust_level || "standard",
      };
    } else {
      // Register new device
      await supabase.from("trusted_devices").insert({
        user_id: userId,
        device_fingerprint: deviceFingerprint,
        device_name: deviceFingerprint.substring(0, 20),
        first_seen_at: now,
        last_used_at: now,
        usage_count: 1,
        trust_level: "new",
        ip_address: ip,
        user_agent: userAgent,
      });

      return {
        isNewDevice: true,
        deviceAge: 0,
        trustLevel: "new",
      };
    }
  } catch (error) {
    console.error("Update device trust error:", error);
    return { isNewDevice: false, deviceAge: 0, trustLevel: "standard" };
  }
}

// Get user's transfer threshold based on device trust and history
async function getUserTransferThreshold(userId, deviceFingerprint) {
  try {
    // Get device info
    const { data: device } = await supabase
      .from("trusted_devices")
      .select("first_seen_at, usage_count, trust_level")
      .eq("user_id", userId)
      .eq("device_fingerprint", deviceFingerprint)
      .single();

    if (!device) {
      return { threshold: 500000, reason: "new_device", level: "new" };
    }

    const deviceAge = Math.floor(
      (Date.now() - new Date(device.first_seen_at)) / (1000 * 60 * 60 * 24),
    );

    // Calculate threshold based on device age
    // Day 0-1: ₦500,000
    // Day 2-6: ₦2,000,000
    // Day 7+: ₦10,000,000 (effectively unlimited for most users)

    if (deviceAge < 2) {
      return {
        threshold: 500000,
        reason: "new_device",
        level: "new",
        deviceAge,
      };
    } else if (deviceAge < 7) {
      return {
        threshold: 2000000,
        reason: "trusted_device",
        level: "trusted",
        deviceAge,
      };
    } else {
      return {
        threshold: 10000000,
        reason: "fully_trusted",
        level: "full",
        deviceAge,
      };
    }
  } catch (error) {
    console.error("Get threshold error:", error);
    return { threshold: 500000, reason: "default", level: "standard" };
  }
}

// Check if user has transferred to this recipient before
async function hasTransferredToBefore(userId, recipientAccountNumber) {
  try {
    // First get recipient's user_id from account number
    const { data: recipientAccount } = await supabase
      .from("accounts")
      .select("user_id")
      .eq("account_number", recipientAccountNumber)
      .single();

    if (!recipientAccount) return false;

    // Check transaction history
    const { data: existingTransfer, error } = await supabase
      .from("transactions")
      .select("id, created_at, amount")
      .eq("from_user_id", userId)
      .eq("to_user_id", recipientAccount.user_id)
      .eq("status", "completed")
      .limit(1);

    return existingTransfer && existingTransfer.length > 0;
  } catch (error) {
    console.error("Check transfer history error:", error);
    return false;
  }
}

// Get recent beneficiaries for a user (last 5 unique recipients)
async function getRecentBeneficiaries(userId) {
  try {
    const { data: transactions } = await supabase
      .from("transactions")
      .select(
        `
        to_user_id,
        to_account_id,
        amount,
        created_at,
        accounts:to_account_id (account_number),
        users:to_user_id (first_name, last_name, email)
      `,
      )
      .eq("from_user_id", userId)
      .eq("status", "completed")
      .order("created_at", { ascending: false });

    // Get unique recipients
    const uniqueRecipients = new Map();

    for (const tx of transactions || []) {
      if (!uniqueRecipients.has(tx.to_user_id) && tx.users) {
        uniqueRecipients.set(tx.to_user_id, {
          user_id: tx.to_user_id,
          name: `${tx.users.first_name || ""} ${tx.users.last_name || ""}`.trim(),
          account_number: tx.accounts?.account_number || "N/A",
          last_transfer: tx.created_at,
          amount: tx.amount,
        });
      }
      if (uniqueRecipients.size >= 5) break;
    }

    return Array.from(uniqueRecipients.values());
  } catch (error) {
    console.error("Get beneficiaries error:", error);
    return [];
  }
}

// Security logging function
async function logSecurityEvent(userId, eventType, details = {}) {
  try {
    await supabase.from("security_logs").insert({
      user_id: userId,
      event_type: eventType,
      details: details,
      ip_address: details.ip || null,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Security logging error:", error);
  }
}

// Notification function - WITH PUSH NOTIFICATIONS
async function createNotification(userId, title, message, type = "info") {
  try {
    // Insert into database
    const { data: notification, error } = await supabase
      .from("notifications")
      .insert({
        user_id: userId,
        title: title,
        message: message,
        type: type,
        created_at: new Date().toISOString(),
        is_read: false,
      })
      .select()
      .single();

    if (error) {
      console.error("Notification insert error:", error);
      return null;
    }

    // SEND PUSH NOTIFICATION TO DEVICE
    await sendPushNotificationForInAppNotification(
      userId,
      title,
      message,
      notification.id,
      type,
    );

    return notification;
  } catch (error) {
    console.error("Notification error:", error);
    return null;
  }
}

// OTP email function
/*async function sendOTPEmail(email, otp) {
  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: email,
      subject: "Your FEECENT Verification Code",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #6b21a8;">FEECENT Security Code</h2>
          <p>Your verification code is:</p>
          <div style="font-size: 32px; font-weight: bold; padding: 20px; background: #f3f4f6; text-align: center; letter-spacing: 5px;">
            ${otp}
          </div>
          <p>This code will expire in 10 minutes.</p>
          <p>If you didn't request this, please ignore this email.</p>
          <hr>
          <p style="font-size: 12px; color: #6b7280;">FEECENT - Secure Digital Banking</p>
        </div>
      `,
    });
  } catch (error) {
    console.error("OTP email error:", error);
  }
}

// Simplified email sending function for Brevo
async function sendOTPEmail(email, otp) {
  console.log(`Attempting to send OTP ${otp} to ${email}`);

  // Check if we have required config
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.error("❌ SMTP credentials missing. Set SMTP_USER and SMTP_PASS");
    // Don't throw - just log and return
    return;
  }

  try {
    // Simplified HTML for better compatibility
    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="font-family: Arial, sans-serif; margin: 0; padding: 20px; background-color: #f5f5f5;">
        <div style="max-width: 500px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
          <div style="background: #6b21a8; padding: 20px; text-align: center;">
            <h1 style="color: white; margin: 0; font-size: 24px;">FEECENT</h1>
            <p style="color: #d8b4fe; margin: 5px 0 0;">Secure Digital Banking</p>
          </div>
          
          <div style="padding: 30px 20px;">
            <h2 style="color: #333; margin-top: 0;">Password Reset Request</h2>
            <p style="color: #666; line-height: 1.6;">We received a request to reset your password. Use the code below to continue:</p>
            
            <div style="background: #f8fafc; padding: 20px; text-align: center; margin: 25px 0; border-radius: 8px;">
              <div style="font-size: 42px; font-weight: bold; letter-spacing: 8px; color: #6b21a8; font-family: monospace;">
                ${otp}
              </div>
            </div>
            
            <p style="color: #666; font-size: 14px;">This code will expire in <strong>10 minutes</strong>.</p>
            <p style="color: #999; font-size: 12px; margin-top: 25px; padding-top: 15px; border-top: 1px solid #eee;">
              If you didn't request this, please ignore this email.
            </p>
          </div>
        </div>
      </body>
      </html>
    `;

    const mailOptions = {
      from: `"FEECENT" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
      to: email,
      subject: "🔐 FEECENT Password Reset Code",
      html: htmlContent,
      text: `Your FEECENT password reset code is: ${otp}. Valid for 10 minutes.`,
    };

    const info = await transporter.sendMail(mailOptions);
    console.log(`✅ Email sent to ${email}, Message ID: ${info.messageId}`);
    return true;
  } catch (error) {
    console.error("❌ Email error details:", {
      message: error.message,
      code: error.code,
      command: error.command,
      response: error.response,
    });

    // Don't throw - just return false
    return false;
  }
}*/

// ==================== SMS CONFIGURATION (AFRICA'S TALKING) ====================

//const africastalking = require("africastalking");

// Initialize Africa's Talking (only if API key exists)
let africasTalkingClient = null;
try {
  if (
    process.env.AFRICASTALKING_API_KEY &&
    process.env.AFRICASTALKING_USERNAME
  ) {
    africasTalkingClient = africastalking({
      apiKey: process.env.AFRICASTALKING_API_KEY,
      username: process.env.AFRICASTALKING_USERNAME, // Your actual username, not "sandbox"
    });
    console.log("✅ Africa's Talking initialized for SMS");
  } else {
    console.log("⚠️ Africa's Talking credentials missing - SMS disabled");
  }
} catch (error) {
  console.error("❌ Africa's Talking initialization error:", error.message);
}

// Send SMS using Africa's Talking
async function sendOTPSMS(phoneNumber, otp) {
  // Skip if client not initialized
  if (!africasTalkingClient) {
    console.log(
      `⚠️ SMS not sent - Africa's Talking not configured. Would send OTP ${otp} to ${phoneNumber}`,
    );
    return false;
  }

  // Format phone number (ensure it has country code)
  let formattedNumber = phoneNumber.trim();
  if (!formattedNumber.startsWith("+")) {
    // Add Nigeria country code if not present
    if (formattedNumber.startsWith("0")) {
      formattedNumber = "+234" + formattedNumber.substring(1);
    } else if (!formattedNumber.startsWith("234")) {
      formattedNumber = "+234" + formattedNumber;
    }
  }

  console.log(
    `📱 Attempting to send SMS to ${formattedNumber} with OTP ${otp}`,
  );

  try {
    const result = await africasTalkingClient.SMS.send({
      to: formattedNumber,
      message: `Your FEECENT verification code is: ${otp}. Valid for 10 minutes. DO NOT share this code with anyone.`,
      from: process.env.AFRICASTALKING_SENDER_ID || "FEECENT",
    });

    console.log("✅ SMS sent successfully:", result);

    // Check if SMS was actually sent (Africa's Talking returns array of results)
    if (result && result.SMSMessageData && result.SMSMessageData.Recipients) {
      const recipient = result.SMSMessageData.Recipients[0];
      if (recipient.status === "Success") {
        console.log(`✅ SMS delivered to ${recipient.number}`);
        return true;
      } else {
        console.error(
          `❌ SMS failed: ${recipient.status} - ${recipient.statusCode}`,
        );
        return false;
      }
    }

    return true;
  } catch (error) {
    console.error("❌ SMS error details:", {
      message: error.message,
      code: error.code,
      response: error.response?.data || error.response,
    });
    return false;
  }
}

// Alternative: Send OTP via SMS with fallback to email
async function sendOTPWithFallback(user, otp) {
  let smsSent = false;
  let emailSent = false;

  // Try SMS first if user has phone
  if (user.phone && user.phone.trim()) {
    smsSent = await sendOTPSMS(user.phone, otp);
  }

  // Always send email as backup (or primary if SMS failed)
  emailSent = await sendOTPEmail(user.email, otp);

  return {
    sms_sent: smsSent,
    email_sent: emailSent,
    method: smsSent ? "sms" : "email",
  };
}

// Add this if missing (adjust path if your folder structure is different)
const {
  authenticate,
  authorizeAdmin,
  checkAccountFrozen,
  logAdminAction,
  otpRateLimiter,
} = require("../middleware/auth"); // ← relative path from api/index.js

// ==================== SECURITY MONITORING ENDPOINTS ====================

// Log security events
app.post("/api/security/events", authenticate, async (req, res) => {
  try {
    const { events } = req.body;

    if (!events || !Array.isArray(events)) {
      return res.status(400).json({ error: "Invalid events data" });
    }

    // Log each event to security_logs table
    for (const event of events) {
      await supabase.from("security_logs").insert({
        user_id: req.user.id,
        event_type: event.type,
        details: event.details,
        ip_address: req.ip,
        user_agent: event.userAgent || req.headers["user-agent"],
        timestamp: new Date(event.timestamp || Date.now()),
      });
    }

    res.json({ success: true, logged: events.length });
  } catch (error) {
    console.error("Security events error:", error);
    // Always return 200 to avoid client-side errors
    res.json({ success: false, error: error.message });
  }
});

// Send heartbeat (keep session alive)
app.post("/api/security/heartbeat", authenticate, async (req, res) => {
  try {
    // Update last activity timestamp in user_sessions table
    const sessionToken = req.headers.authorization?.split(" ")[1];

    if (sessionToken) {
      await supabase
        .from("user_sessions")
        .update({ last_activity: new Date().toISOString() })
        .eq("session_token", sessionToken)
        .eq("user_id", req.user.id)
        .eq("is_active", true);
    }

    res.json({ success: true, timestamp: new Date().toISOString() });
  } catch (error) {
    console.error("Heartbeat error:", error);
    res.json({ success: false });
  }
});

// Check if session is compromised
app.get("/api/security/check-session", authenticate, async (req, res) => {
  try {
    const sessionToken = req.headers.authorization?.split(" ")[1];

    if (!sessionToken) {
      return res.json({ isCompromised: false });
    }

    // Check for multiple active sessions from different IPs/UserAgents
    const { data: sessions, error } = await supabase
      .from("user_sessions")
      .select("id, ip_address, user_agent, created_at")
      .eq("user_id", req.user.id)
      .eq("is_active", true)
      .neq("session_token", sessionToken);

    if (error) {
      console.error("Session check error:", error);
      return res.json({ isCompromised: false });
    }

    // If there are multiple active sessions from different locations within a short time
    const suspicious = sessions && sessions.length > 2;

    res.json({
      isCompromised: suspicious,
      active_sessions_count: sessions?.length || 0,
    });
  } catch (error) {
    console.error("Session check error:", error);
    res.json({ isCompromised: false });
  }
});

// Get user's security events (for their own dashboard)
app.get("/api/user/security-events", authenticate, async (req, res) => {
  try {
    const { limit = 50 } = req.query;

    const { data: events, error } = await supabase
      .from("security_logs")
      .select("*")
      .eq("user_id", req.user.id)
      .order("timestamp", { ascending: false })
      .limit(parseInt(limit));

    if (error) throw error;

    res.json({ events: events || [] });
  } catch (error) {
    console.error("Security events fetch error:", error);
    res.status(500).json({ error: "Failed to fetch security events" });
  }
});

// Revoke all other sessions (security feature)
app.post(
  "/api/security/revoke-other-sessions",
  authenticate,
  async (req, res) => {
    try {
      const currentToken = req.headers.authorization?.split(" ")[1];

      if (!currentToken) {
        return res.status(400).json({ error: "Invalid session" });
      }

      // Deactivate all other sessions
      const { error } = await supabase
        .from("user_sessions")
        .update({ is_active: false, expires_at: new Date().toISOString() })
        .eq("user_id", req.user.id)
        .neq("session_token", currentToken);

      if (error) throw error;

      // Log security event
      await supabase.from("security_logs").insert({
        user_id: req.user.id,
        event_type: "revoked_other_sessions",
        details: { action: "user_initiated" },
        ip_address: req.ip,
      });

      res.json({ success: true, message: "Other sessions revoked" });
    } catch (error) {
      console.error("Revoke sessions error:", error);
      res.status(500).json({ error: "Failed to revoke sessions" });
    }
  },
);

// Validate session endpoint
app.get("/api/auth/validate-session", authenticate, async (req, res) => {
  try {
    // Check if user still exists and is active
    const { data: user, error } = await supabase
      .from("users")
      .select("id, is_active, is_frozen")
      .eq("id", req.user.id)
      .single();

    if (error || !user || !user.is_active || user.is_frozen) {
      return res.status(401).json({ error: "Session invalid" });
    }

    res.json({ valid: true });
  } catch (error) {
    res.status(401).json({ error: "Session validation failed" });
  }
});

// ==================== API CONNECTION TEST ENDPOINT ====================
// Simple test endpoint to verify API is running and properly deployed
app.get("/api/test-connection", (req, res) => {
  console.log("Test connection endpoint hit at:", new Date().toISOString());

  res.json({
    success: true,
    message: "API is connected and working properly! ✅",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || "development",
    api_version: "1.0.0",
    endpoints_available: {
      auth: "/api/auth/*",
      user: "/api/user/*",
      admin: "/api/admin/*",
      savings: "/api/user/savings/*",
      test: "/api/test-connection",
    },
  });
});

// Also add a POST version for testing with body
app.post("/api/test-connection", (req, res) => {
  console.log("POST test connection hit at:", new Date().toISOString());
  console.log("Request body:", req.body);

  res.json({
    success: true,
    message: "POST test successful! ✅",
    received_data: req.body,
    timestamp: new Date().toISOString(),
  });
});

// ==================== AUTHENTICATION ROUTES ====================
// Register - Fixed with proper face image storage
app.post("/api/auth/register", async (req, res) => {
  try {
    const {
      email,
      password,
      first_name,
      last_name,
      middle_name,
      phone,
      country,
      state,
      city,
      address,
      postal_code,
      date_of_birth,
      gender,
      marital_status,
      occupation,
      referral_code,
      age,
      identification_type,
      identification_number,
      security_question_1,
      security_answer_1,
      security_question_2,
      security_answer_2,
      passcode,
      face_images,
    } = req.body;

    console.log("Registration attempt for:", email);
    console.log("Face images received:", face_images ? face_images.length : 0);

    // Validation
    if (age && (age < 18 || age > 120)) {
      return res.status(400).json({ error: "Age must be between 18 and 120" });
    }

    // Validate passcode (6 digits)
    if (passcode && !/^\d{6}$/.test(passcode)) {
      return res
        .status(400)
        .json({ error: "Passcode must be exactly 6 digits" });
    }

    // Check if user exists
    const { data: existingUser } = await supabase
      .from("users")
      .select("email")
      .eq("email", email)
      .single();

    if (existingUser) {
      return res.status(400).json({ error: "Email already registered" });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Hash passcode if provided
    let hashedPasscode = null;
    if (passcode) {
      hashedPasscode = await bcrypt.hash(passcode, 10);
    }

    // Hash security answers
    const hashedAnswer1 = await bcrypt.hash(
      security_answer_1?.toLowerCase().trim() || "",
      10,
    );
    const hashedAnswer2 = await bcrypt.hash(
      security_answer_2?.toLowerCase().trim() || "",
      10,
    );

    // Calculate age from date_of_birth if not provided
    let calculatedAge = age;
    if (!calculatedAge && date_of_birth) {
      const birthDate = new Date(date_of_birth);
      const today = new Date();
      calculatedAge = today.getFullYear() - birthDate.getFullYear();
      const monthDiff = today.getMonth() - birthDate.getMonth();
      if (
        monthDiff < 0 ||
        (monthDiff === 0 && today.getDate() < birthDate.getDate())
      ) {
        calculatedAge--;
      }
    }

    // Create user with all fields
    const { data: user, error } = await supabase
      .from("users")
      .insert({
        email,
        password_hash: hashedPassword,
        first_name,
        last_name,
        middle_name: middle_name || null,
        phone,
        country: country || null,
        state: state || null,
        city: city || null,
        address: address || null,
        postal_code: postal_code || null,
        date_of_birth: date_of_birth || null,
        gender: gender || null,
        marital_status: marital_status || null,
        occupation: occupation || null,
        referral_code: referral_code || null,
        age: calculatedAge || null,
        identification_type: identification_type || null,
        identification_number: identification_number || null,
        security_question_1,
        security_answer_1: hashedAnswer1,
        security_question_2,
        security_answer_2: hashedAnswer2,
        passcode_hash: hashedPasscode,
        passcode_set_at: hashedPasscode ? new Date().toISOString() : null,
        face_verified: !!face_images && face_images.length > 0,
        face_verification_date:
          face_images && face_images.length > 0
            ? new Date().toISOString()
            : null,
        role: "user",
        kyc_status: "pending",
        is_active: true,
        is_frozen: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) {
      console.error("Supabase insert error:", error);
      throw error;
    }

    console.log("User created with ID:", user.id);

    // ========== FIXED: Store face images properly ==========
    if (face_images && face_images.length > 0) {
      console.log(
        `Storing ${face_images.length} face images for user ${user.id}`,
      );

      for (let i = 0; i < face_images.length; i++) {
        const faceImage = face_images[i];

        // Store each face image with full descriptor object
        const { error: descriptorError } = await supabase
          .from("face_descriptors")
          .insert({
            user_id: user.id,
            descriptor: {
              image: faceImage, // Store the actual base64 image
              angle: i,
              timestamp: new Date().toISOString(),
              compressed: true,
              format: "jpeg",
            },
            is_active: true,
            created_at: new Date().toISOString(),
          });

        if (descriptorError) {
          console.error(`Error storing face image ${i}:`, descriptorError);
        } else {
          console.log(
            `Successfully stored face image ${i + 1}/${face_images.length}`,
          );
        }
      }

      // Also store the first face image in the users table for quick access
      const { error: updateError } = await supabase
        .from("users")
        .update({
          face_embedding: {
            image: face_images[0], // Store first image as preview
            count: face_images.length,
            stored_at: new Date().toISOString(),
          },
        })
        .eq("id", user.id);

      if (updateError) {
        console.error("Error updating user with face preview:", updateError);
      }
    }

    // Create checking account for user
    const { error: accountError } = await supabase.from("accounts").insert({
      user_id: user.id,
      account_type: "checking",
      currency: "NGN",
      balance: 0.0,
      available_balance: 0.0,
      status: "active",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    if (accountError) {
      console.error("Account creation error:", accountError);
    }

    // Generate token
    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRE },
    );

    // Return user data with face info
    res.status(201).json({
      message: "User created successfully",
      token,
      user: {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        middle_name: user.middle_name,
        role: user.role,
        phone: user.phone,
        country: user.country,
        state: user.state,
        city: user.city,
        age: user.age,
        gender: user.gender,
        marital_status: user.marital_status,
        occupation: user.occupation,
        identification_type: user.identification_type,
        identification_number: user.identification_number,
        has_passcode: !!user.passcode_hash,
        face_verified: user.face_verified,
        face_images_count: face_images ? face_images.length : 0,
      },
    });
  } catch (error) {
    console.error("Registration error:", error);
    res.status(500).json({ error: "Registration failed: " + error.message });
  }
});

// Login
// Enhanced login with rate limiting and device fingerprint
app.post("/api/auth/login", authLimiter, async (req, res) => {
  try {
    const { email, password, fingerprint } = req.body;
    const ip = req.ip;

    // Check failed attempts
    const attemptsKey = `${ip}:${email}`;
    const attempts = failedAttempts.get(attemptsKey) || {
      count: 0,
      firstAttempt: Date.now(),
    };

    // Reset after 15 minutes
    if (Date.now() - attempts.firstAttempt > 15 * 60 * 1000) {
      attempts.count = 0;
      attempts.firstAttempt = Date.now();
    }

    if (attempts.count >= 5) {
      return res.status(429).json({
        error: "Too many failed attempts. Account temporarily locked.",
      });
    }

    // Get user
    const { data: user, error } = await supabase
      .from("users")
      .select("*")
      .eq("email", email)
      .single();

    if (error || !user) {
      attempts.count++;
      failedAttempts.set(attemptsKey, attempts);
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Check password
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      attempts.count++;
      failedAttempts.set(attemptsKey, attempts);

      // Log failed attempt
      await logSecurityEvent(user.id, "failed_login", { ip, fingerprint });

      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Check if account is active
    if (!user.is_active) {
      return res.status(403).json({ error: "Account is deactivated" });
    }

    // Check if account is frozen
    if (user.is_frozen) {
      return res.status(403).json({
        error: "Account frozen",
        freeze_reason: user.freeze_reason,
        unfreeze_method: user.unfreeze_method,
      });
    }

    // Check device fingerprint (if provided)
    if (
      fingerprint &&
      user.device_fingerprint &&
      fingerprint !== user.device_fingerprint
    ) {
      await logSecurityEvent(user.id, "new_device_login", { ip, fingerprint });
      // Don't block, just notify
    }

    // Update device fingerprint
    if (fingerprint && !user.device_fingerprint) {
      await supabase
        .from("users")
        .update({ device_fingerprint: fingerprint })
        .eq("id", user.id);
    }

    // Clear failed attempts on successful login
    failedAttempts.delete(attemptsKey);

    // Log successful login
    await logSecurityEvent(user.id, "successful_login", { ip, fingerprint });

    // Check 2FA
    if (user.two_factor_enabled) {
      // Generate and send OTP
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

      await supabase.from("otps").insert({
        user_id: user.id,
        otp_code: otp,
        otp_type: "login",
        expires_at: expiresAt,
      });

      // Send OTP via email
      await sendOTPEmail(user.email, otp);

      return res.json({
        requiresTwoFactor: true,
        userId: user.id,
        message: "OTP sent to your email",
      });
    }

    // Generate token with device info
    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        role: user.role,
        fingerprint: fingerprint,
        issuedAt: Date.now(),
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRE },
    );

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        role: user.role,
        is_frozen: user.is_frozen,
        kyc_status: user.kyc_status,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Login failed" });
  }
});

// ==================== PASSCODE AUTHENTICATION ROUTES ====================

// Check if user has passcode set
app.post("/api/auth/check-passcode", async (req, res) => {
  try {
    const { identifier } = req.body;

    let query = supabase
      .from("users")
      .select("id, email, first_name, last_name, passcode_hash, phone");

    if (identifier.includes("@")) {
      query = query.eq("email", identifier);
    } else {
      query = query.eq("phone", identifier);
    }

    const { data: user, error } = await query.single();

    if (error || !user) {
      return res.status(404).json({ error: "Account not found" });
    }

    const hasPasscode = !!(user.passcode_hash && user.passcode_hash !== null);

    res.json({
      has_passcode: hasPasscode,
      user: {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
      },
    });
  } catch (error) {
    console.error("Check passcode error:", error);
    res.status(500).json({ error: "Failed to check passcode" });
  }
});

// Verify passcode login
app.post("/api/auth/verify-passcode", async (req, res) => {
  try {
    const { user_id, passcode } = req.body;

    if (!passcode || passcode.length !== 6 || !/^\d{6}$/.test(passcode)) {
      return res.status(400).json({ error: "Invalid passcode format" });
    }

    const { data: user, error } = await supabase
      .from("users")
      .select("*")
      .eq("id", user_id)
      .single();

    if (error || !user)
      return res.status(404).json({ error: "User not found" });
    if (!user.is_active)
      return res.status(403).json({ error: "Account is deactivated" });
    if (user.is_frozen)
      return res.status(403).json({ error: "Account is frozen" });

    const maxAttempts = 5;
    const attemptWindow = 15 * 60 * 1000;

    if (user.passcode_attempts >= maxAttempts) {
      const lastAttempt = new Date(user.last_passcode_attempt);
      if (Date.now() - lastAttempt < attemptWindow) {
        return res
          .status(429)
          .json({ error: "Too many incorrect attempts. Try again later." });
      } else {
        await supabase
          .from("users")
          .update({ passcode_attempts: 0 })
          .eq("id", user_id);
      }
    }

    const isValid = await bcrypt.compare(passcode, user.passcode_hash);

    if (!isValid) {
      const newAttempts = (user.passcode_attempts || 0) + 1;
      await supabase
        .from("users")
        .update({
          passcode_attempts: newAttempts,
          last_passcode_attempt: new Date(),
        })
        .eq("id", user_id);
      return res.status(401).json({
        error: "Invalid passcode",
        attempts_remaining: maxAttempts - newAttempts,
      });
    }

    // Reset attempts on success
    await supabase
      .from("users")
      .update({
        passcode_attempts: 0,
        last_passcode_attempt: null,
        last_login: new Date(),
      })
      .eq("id", user_id);

    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRE },
    );

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("Passcode verification error:", error);
    res.status(500).json({ error: "Verification failed" });
  }
});

// Set/Update passcode (user)
app.post("/api/user/set-passcode", authenticate, async (req, res) => {
  try {
    const { passcode } = req.body;

    if (!passcode || passcode.length !== 6 || !/^\d{6}$/.test(passcode)) {
      return res
        .status(400)
        .json({ error: "Passcode must be exactly 6 digits" });
    }

    const hashedPasscode = await bcrypt.hash(passcode, 10);

    const { error } = await supabase
      .from("users")
      .update({
        passcode_hash: hashedPasscode,
        passcode_set_at: new Date(),
        passcode_attempts: 0,
        updated_at: new Date(),
      })
      .eq("id", req.user.id);

    if (error) throw error;

    res.json({ success: true, message: "Passcode set successfully" });
  } catch (error) {
    console.error("Set passcode error:", error);
    res.status(500).json({ error: "Failed to set passcode" });
  }
});

// Change passcode (requires current passcode verification)
app.post("/api/user/change-passcode", authenticate, async (req, res) => {
  try {
    const { current_passcode, new_passcode } = req.body;

    if (
      !new_passcode ||
      new_passcode.length !== 6 ||
      !/^\d{6}$/.test(new_passcode)
    ) {
      return res
        .status(400)
        .json({ error: "New passcode must be exactly 6 digits" });
    }

    const { data: user, error } = await supabase
      .from("users")
      .select("passcode_hash")
      .eq("id", req.user.id)
      .single();

    if (error) throw error;

    // If user has a passcode, verify current one
    if (user.passcode_hash) {
      if (!current_passcode) {
        return res.status(400).json({ error: "Current passcode required" });
      }

      const isValid = await bcrypt.compare(
        current_passcode,
        user.passcode_hash,
      );
      if (!isValid) {
        return res.status(401).json({ error: "Current passcode is incorrect" });
      }
    }

    const hashedPasscode = await bcrypt.hash(new_passcode, 10);

    await supabase
      .from("users")
      .update({
        passcode_hash: hashedPasscode,
        passcode_set_at: new Date(),
        passcode_attempts: 0,
        updated_at: new Date(),
      })
      .eq("id", req.user.id);

    res.json({ success: true, message: "Passcode changed successfully" });
  } catch (error) {
    console.error("Change passcode error:", error);
    res.status(500).json({ error: "Failed to change passcode" });
  }
});

// ==================== FACE VERIFICATION ROUTES ====================

// Store face descriptor during registration
app.post("/api/auth/register-face", authenticate, async (req, res) => {
  try {
    const { face_descriptor } = req.body;

    if (!face_descriptor || !Array.isArray(face_descriptor)) {
      return res.status(400).json({ error: "Invalid face descriptor" });
    }

    // Store face descriptor
    const { error } = await supabase.from("face_descriptors").insert({
      user_id: req.user.id,
      descriptor: face_descriptor,
      is_active: true,
    });

    if (error) throw error;

    res.json({ success: true, message: "Face registered successfully" });
  } catch (error) {
    console.error("Face registration error:", error);
    res.status(500).json({ error: "Failed to register face" });
  }
});

// Register face during user registration (add to existing registration route)
async function registerFaceWithAI(userId, faceImages) {
  try {
    const response = await axios.post(
      `${AI_SERVICE_URL}/v1/face/register`,
      {
        images: faceImages,
        user_id: userId,
      },
      {
        headers: {
          Authorization: `Bearer ${AI_SERVICE_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      },
    );

    if (response.data && response.data.success) {
      // Store encrypted embedding in database
      const { error } = await supabase
        .from("users")
        .update({
          face_embedding: response.data.embedding,
          face_verified: true,
          face_verification_date: new Date().toISOString(),
          face_quality_score: response.data.average_quality,
        })
        .eq("id", userId);

      if (error) {
        console.error("Failed to save face embedding:", error);
        return false;
      }

      return true;
    }

    return false;
  } catch (error) {
    console.error("AI service registration error:", error);
    return false;
  }
}

// Verify face with AI
async function verifyFaceWithAI(userId, faceImage, sessionId) {
  try {
    // Get stored embedding
    const { data: user, error } = await supabase
      .from("users")
      .select("face_embedding")
      .eq("id", userId)
      .single();

    if (error || !user || !user.face_embedding) {
      return { success: false, error: "No face registered for this user" };
    }

    const response = await axios.post(
      `${AI_SERVICE_URL}/v1/face/verify`,
      {
        image: faceImage,
        stored_embedding: user.face_embedding,
        user_id: userId,
      },
      {
        headers: {
          Authorization: `Bearer ${AI_SERVICE_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      },
    );

    return response.data;
  } catch (error) {
    console.error("AI service verification error:", error);
    return { success: false, error: "Face verification failed" };
  }
}

// Verify liveness with AI
async function verifyLivenessWithAI(frames) {
  try {
    const response = await axios.post(
      `${AI_SERVICE_URL}/v1/face/liveness`,
      {
        frames: frames,
      },
      {
        headers: {
          Authorization: `Bearer ${AI_SERVICE_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 20000,
      },
    );

    return response.data;
  } catch (error) {
    console.error("AI service liveness error:", error);
    return {
      success: false,
      is_live: false,
      error: "Liveness detection failed",
    };
  }
}

// Generate secure session ID for face verification
function generateFaceSessionId() {
  return crypto.randomBytes(32).toString("hex");
}

// New endpoint: Start face verification session
app.post("/api/auth/face/start-session", async (req, res) => {
  try {
    const { identifier } = req.body;

    if (!identifier) {
      return res.status(400).json({ error: "Identifier required" });
    }

    // Find user
    let query = supabase.from("users").select("id, email, face_embedding");
    if (identifier.includes("@")) {
      query = query.eq("email", identifier);
    } else {
      query = query.eq("phone", identifier);
    }

    const { data: user, error } = await query.single();

    if (error || !user) {
      return res.status(404).json({ error: "User not found" });
    }

    if (!user.face_embedding) {
      return res
        .status(400)
        .json({ error: "Face not registered for this user" });
    }

    const sessionId = generateFaceSessionId();

    faceVerificationStates.set(sessionId, {
      user_id: user.id,
      timestamp: Date.now(),
      attempts: 0,
    });

    // Clean up old sessions periodically
    setTimeout(() => {
      faceVerificationStates.delete(sessionId);
    }, 300000); // 5 minutes

    res.json({
      success: true,
      session_id: sessionId,
      message: "Face verification session started",
    });
  } catch (error) {
    console.error("Start face session error:", error);
    res.status(500).json({ error: "Failed to start session" });
  }
});

// Enhanced face login endpoint with multi-frame liveness
app.post("/api/auth/face/login", async (req, res) => {
  try {
    const { session_id, frames, final_image } = req.body;

    if (!session_id || !frames || !final_image) {
      return res.status(400).json({ error: "Missing required data" });
    }

    // Get session
    const session = faceVerificationStates.get(session_id);
    if (!session) {
      return res.status(401).json({ error: "Invalid or expired session" });
    }

    // Check attempts
    if (session.attempts >= 3) {
      faceVerificationStates.delete(session_id);
      return res
        .status(429)
        .json({ error: "Too many attempts. Please try again." });
    }

    // Update attempts
    session.attempts++;
    faceVerificationStates.set(session_id, session);

    // Step 1: Verify liveness with multiple frames
    const livenessResult = await verifyLivenessWithAI(frames);

    if (!livenessResult.success || !livenessResult.is_live) {
      return res.status(401).json({
        error: "Liveness verification failed",
        details:
          "Please look directly at the camera and complete the verification steps",
      });
    }

    // Step 2: Verify face match
    const verificationResult = await verifyFaceWithAI(
      session.user_id,
      final_image,
      session_id,
    );

    if (!verificationResult.success) {
      return res.status(401).json({
        error: verificationResult.error || "Face verification failed",
      });
    }

    if (!verificationResult.matched) {
      return res.status(401).json({
        error: "Face not recognized",
        similarity_score: verificationResult.similarity_score,
      });
    }

    // Get user data
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("id, email, first_name, last_name, role")
      .eq("id", session.user_id)
      .single();

    if (userError || !user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Check account status
    if (user.is_frozen) {
      return res
        .status(403)
        .json({ error: "Account frozen", freeze_reason: user.freeze_reason });
    }

    if (!user.is_active) {
      return res.status(403).json({ error: "Account deactivated" });
    }

    // Generate JWT token
    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRE },
    );

    // Update last login
    await supabase
      .from("users")
      .update({ last_login: new Date() })
      .eq("id", user.id);

    // Log successful face login
    await supabase.from("security_logs").insert({
      user_id: user.id,
      event_type: "face_login_success",
      details: {
        similarity_score: verificationResult.similarity_score,
        quality_score: verificationResult.quality_score,
      },
      ip_address: req.ip,
    });

    // Clean up session
    faceVerificationStates.delete(session_id);

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("Face login error:", error);
    res.status(500).json({ error: "Face login failed" });
  }
});

// Resend OTP
app.post("/api/auth/resend-otp", async (req, res) => {
  try {
    const { identifier } = req.body;

    // Find user
    const { data: user, error } = await supabase
      .from("users")
      .select("id, email")
      .eq("email", identifier)
      .single();

    if (error || !user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Generate new OTP
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    // Delete old OTPs
    await supabase
      .from("otps")
      .delete()
      .eq("user_id", user.id)
      .eq("otp_type", "login");

    // Create new OTP
    await supabase.from("otps").insert({
      user_id: user.id,
      otp_code: otpCode,
      otp_type: "login",
      expires_at: expiresAt,
    });

    // Send email
    await sendOTPEmail(user.email, otpCode);

    res.json({ success: true, message: "OTP sent successfully" });
  } catch (error) {
    console.error("Resend OTP error:", error);
    res.status(500).json({ error: "Failed to resend OTP" });
  }
});

// Verify OTP for login
app.post("/api/auth/verify-otp-login", async (req, res) => {
  try {
    const { identifier, otp_code, transaction_id } = req.body;

    // Find user
    const { data: user, error } = await supabase
      .from("users")
      .select("*")
      .eq("email", identifier)
      .single();

    if (error || !user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Verify OTP
    const { data: otpRecord, error: otpError } = await supabase
      .from("otps")
      .select("*")
      .eq("user_id", user.id)
      .eq("otp_code", otp_code)
      .eq("otp_type", "login")
      .eq("is_used", false)
      .single();

    if (otpError || !otpRecord) {
      return res.status(401).json({ error: "Invalid OTP" });
    }

    if (new Date(otpRecord.expires_at) < new Date()) {
      return res.status(401).json({ error: "OTP has expired" });
    }

    // Mark OTP as used
    await supabase
      .from("otps")
      .update({ is_used: true })
      .eq("id", otpRecord.id);

    // Update last login
    await supabase
      .from("users")
      .update({ last_login: new Date() })
      .eq("id", user.id);

    // Generate token
    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRE },
    );

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("OTP verification error:", error);
    res.status(500).json({ error: "Verification failed" });
  }
});

// Helper function for Euclidean distance
function calculateEuclideanDistance(desc1, desc2) {
  let sum = 0;
  for (let i = 0; i < desc1.length; i++) {
    sum += Math.pow(desc1[i] - desc2[i], 2);
  }
  return Math.sqrt(sum);
}

// Check if user has passcode (for settings page)
app.get("/api/user/has-passcode", authenticate, async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from("users")
      .select("passcode_hash")
      .eq("id", req.user.id)
      .single();

    if (error) throw error;

    res.json({
      has_passcode: !!(user.passcode_hash && user.passcode_hash !== null),
    });
  } catch (error) {
    console.error("Has passcode error:", error);
    res.status(500).json({ error: "Failed to check passcode status" });
  }
});

// Helper function for Euclidean distance
function calculateEuclideanDistance(desc1, desc2) {
  let sum = 0;
  for (let i = 0; i < desc1.length; i++) {
    sum += Math.pow(desc1[i] - desc2[i], 2);
  }
  return Math.sqrt(sum);
}

// ==================== PASSCODE OTP ROUTES ====================

// Send OTP for passcode change/set - EMAIL FIRST
app.post("/api/user/send-passcode-otp", authenticate, async (req, res) => {
  try {
    const { method = "email" } = req.body; // Default to email, but accept method param

    const { data: user, error } = await supabase
      .from("users")
      .select("id, email, phone")
      .eq("id", req.user.id)
      .single();

    if (error) throw error;

    // Generate OTP
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    const requestId = uuidv4();

    // Store OTP request
    const { data: otpRequest, error: insertError } = await supabase
      .from("passcode_otp_requests")
      .insert({
        id: requestId,
        user_id: req.user.id,
        otp_code: otpCode,
        expires_at: expiresAt,
        is_used: false,
      })
      .select()
      .single();

    if (insertError) throw insertError;

    // Send OTP based on requested method (default to email)
    let sentMethod = "email";
    let contact = user.email;
    let sent = false;

    if (method === "sms" && user.phone && user.phone.trim()) {
      try {
        await sendOTPSMS(user.phone, otpCode);
        sent = true;
        sentMethod = "sms";
        contact = maskPhoneNumber(user.phone);
        console.log(`OTP sent via SMS to ${user.phone}`);
      } catch (smsError) {
        console.error("SMS send failed, falling back to email:", smsError);
        await sendOTPEmail(user.email, otpCode);
        sentMethod = "email";
        contact = maskEmail(user.email);
      }
    } else {
      // Default to email
      const emailSent = await sendOTPEmail(user.email, otpCode);
      if (emailSent) {
        sentMethod = "email";
        contact = maskEmail(user.email);
        console.log(`OTP sent via email to ${user.email}`);
      } else {
        // If email fails, try SMS as fallback
        if (user.phone && user.phone.trim()) {
          try {
            await sendOTPSMS(user.phone, otpCode);
            sentMethod = "sms";
            contact = maskPhoneNumber(user.phone);
            console.log(`OTP sent via SMS fallback to ${user.phone}`);
          } catch (smsError) {
            console.error("SMS fallback also failed:", smsError);
            throw new Error("Failed to send OTP via any method");
          }
        } else {
          throw new Error(
            "Failed to send OTP via email and no phone available",
          );
        }
      }
    }

    res.json({
      success: true,
      request_id: requestId,
      method: sentMethod,
      contact: contact,
      message: `Verification code sent to your ${sentMethod}`,
    });
  } catch (error) {
    console.error("Send passcode OTP error:", error);
    res
      .status(500)
      .json({ error: "Failed to send verification code: " + error.message });
  }
});

// Resend passcode OTP - UPDATED to accept method parameter
app.post("/api/user/resend-passcode-otp", authenticate, async (req, res) => {
  try {
    const { request_id, method = "email" } = req.body;

    // Invalidate old request
    await supabase
      .from("passcode_otp_requests")
      .update({ is_used: true })
      .eq("id", request_id)
      .eq("user_id", req.user.id);

    // Get user
    const { data: user, error } = await supabase
      .from("users")
      .select("id, email, phone")
      .eq("id", req.user.id)
      .single();

    if (error) throw error;

    // Generate new OTP
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const newRequestId = uuidv4();

    const { data: otpRequest, error: insertError } = await supabase
      .from("passcode_otp_requests")
      .insert({
        id: newRequestId,
        user_id: req.user.id,
        otp_code: otpCode,
        expires_at: expiresAt,
        is_used: false,
      })
      .select()
      .single();

    if (insertError) throw insertError;

    // Send OTP based on requested method
    let sentMethod = "email";
    let contact = user.email;
    let sent = false;

    if (method === "sms" && user.phone && user.phone.trim()) {
      try {
        await sendOTPSMS(user.phone, otpCode);
        sent = true;
        sentMethod = "sms";
        contact = maskPhoneNumber(user.phone);
      } catch (smsError) {
        console.error("SMS send failed, falling back to email:", smsError);
        await sendOTPEmail(user.email, otpCode);
        sentMethod = "email";
        contact = maskEmail(user.email);
      }
    } else {
      await sendOTPEmail(user.email, otpCode);
      sentMethod = "email";
      contact = maskEmail(user.email);
    }

    res.json({
      success: true,
      request_id: newRequestId,
      method: sentMethod,
      contact: contact,
    });
  } catch (error) {
    console.error("Resend passcode OTP error:", error);
    res.status(500).json({ error: "Failed to resend code" });
  }
});

// Set passcode with OTP verification
app.post("/api/user/set-passcode-with-otp", authenticate, async (req, res) => {
  try {
    const { passcode, otp_code, request_id } = req.body;

    if (!passcode || passcode.length !== 6 || !/^\d{6}$/.test(passcode)) {
      return res
        .status(400)
        .json({ error: "Passcode must be exactly 6 digits" });
    }

    // Verify OTP
    const { data: otpRequest, error: otpError } = await supabase
      .from("passcode_otp_requests")
      .select("*")
      .eq("id", request_id)
      .eq("user_id", req.user.id)
      .eq("otp_code", otp_code)
      .eq("is_used", false)
      .single();

    if (otpError || !otpRequest) {
      return res
        .status(401)
        .json({ error: "Invalid or expired verification code" });
    }

    if (new Date(otpRequest.expires_at) < new Date()) {
      return res.status(401).json({ error: "Verification code has expired" });
    }

    // Mark OTP as used
    await supabase
      .from("passcode_otp_requests")
      .update({ is_used: true })
      .eq("id", request_id);

    // Hash and save passcode
    const hashedPasscode = await bcrypt.hash(passcode, 10);

    await supabase
      .from("users")
      .update({
        passcode_hash: hashedPasscode,
        passcode_set_at: new Date(),
        passcode_attempts: 0,
      })
      .eq("id", req.user.id);

    // Send confirmation
    await createNotification(
      req.user.id,
      "Passcode Set",
      "Your transaction passcode has been set successfully.",
      "success",
    );

    res.json({ success: true, message: "Passcode set successfully" });
  } catch (error) {
    console.error("Set passcode with OTP error:", error);
    res.status(500).json({ error: "Failed to set passcode" });
  }
});

// Change passcode with OTP verification
app.post(
  "/api/user/change-passcode-with-otp",
  authenticate,
  async (req, res) => {
    try {
      const { current_passcode, new_passcode, otp_code, request_id } = req.body;

      if (
        !new_passcode ||
        new_passcode.length !== 6 ||
        !/^\d{6}$/.test(new_passcode)
      ) {
        return res
          .status(400)
          .json({ error: "New passcode must be exactly 6 digits" });
      }

      // Get user's current passcode
      const { data: user, error: userError } = await supabase
        .from("users")
        .select("passcode_hash")
        .eq("id", req.user.id)
        .single();

      if (userError) throw userError;

      // Verify current passcode if exists
      if (user.passcode_hash) {
        if (!current_passcode) {
          return res.status(400).json({ error: "Current passcode required" });
        }
        const isValid = await bcrypt.compare(
          current_passcode,
          user.passcode_hash,
        );
        if (!isValid) {
          return res
            .status(401)
            .json({ error: "Current passcode is incorrect" });
        }
      }

      // Verify OTP
      const { data: otpRequest, error: otpError } = await supabase
        .from("passcode_otp_requests")
        .select("*")
        .eq("id", request_id)
        .eq("user_id", req.user.id)
        .eq("otp_code", otp_code)
        .eq("is_used", false)
        .single();

      if (otpError || !otpRequest) {
        return res
          .status(401)
          .json({ error: "Invalid or expired verification code" });
      }

      if (new Date(otpRequest.expires_at) < new Date()) {
        return res.status(401).json({ error: "Verification code has expired" });
      }

      // Mark OTP as used
      await supabase
        .from("passcode_otp_requests")
        .update({ is_used: true })
        .eq("id", request_id);

      // Hash and save new passcode
      const hashedPasscode = await bcrypt.hash(new_passcode, 10);

      await supabase
        .from("users")
        .update({
          passcode_hash: hashedPasscode,
          passcode_set_at: new Date(),
          passcode_attempts: 0,
        })
        .eq("id", req.user.id);

      // Send confirmation
      await createNotification(
        req.user.id,
        "Passcode Changed",
        "Your transaction passcode has been changed successfully.",
        "success",
      );

      res.json({ success: true, message: "Passcode changed successfully" });
    } catch (error) {
      console.error("Change passcode with OTP error:", error);
      res.status(500).json({ error: "Failed to change passcode" });
    }
  },
);

// Helper functions for masking
function maskEmail(email) {
  if (!email) return email;
  const [local, domain] = email.split("@");
  if (local.length <= 2) return email;
  const maskedLocal = local[0] + "***" + local[local.length - 1];
  return `${maskedLocal}@${domain}`;
}

function maskPhoneNumber(phone) {
  if (!phone) return phone;
  if (phone.length <= 4) return phone;
  const start = phone.substring(0, 3);
  const end = phone.substring(phone.length - 2);
  return `${start}****${end}`;
}

const africastalking = require("africastalking")({
  apiKey: process.env.AFRICASTALKING_API_KEY,
  username: process.env.AFRICASTALKING_USERNAME,
});

async function sendOTPSMS(phoneNumber, otp) {
  try {
    const result = await africastalking.SMS.send({
      to: phoneNumber,
      message: `Your FEECENT verification code is: ${otp}. Valid for 10 minutes. DO NOT share this code.`,
      from: process.env.AFRICASTALKING_SENDER_ID,
    });
    console.log("SMS sent:", result);
  } catch (error) {
    console.error("SMS error:", error);
    throw error;
  }
}

// ==================== FORGOT PASSWORD ROUTES (EMAIL ONLY) ====================

// Step 1: Request OTP via Email Only
app.post("/api/auth/forgot-password", async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: "Email required" });
  }

  const normalizedEmail = email.trim().toLowerCase();

  console.log(`📧 Password reset requested for: ${normalizedEmail}`);

  try {
    // Check if user exists
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("id, email")
      .eq("email", normalizedEmail)
      .maybeSingle();

    // Always return success to prevent email enumeration
    if (!user) {
      console.log(`User not found: ${normalizedEmail}`);
      return res.json({
        message: "If your email is registered, you will receive a reset code.",
      });
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    console.log(`Generated OTP ${otp} for user ${user.id}`);

    // First, mark any existing OTPs as used (soft delete)
    await supabase
      .from("password_resets")
      .update({ used: true })
      .eq("email", normalizedEmail)
      .eq("used", false);

    // Insert new OTP
    const { error: insertError } = await supabase
      .from("password_resets")
      .insert({
        email: normalizedEmail,
        otp: otp,
        expires_at: expiresAt.toISOString(),
        used: false,
        created_at: new Date().toISOString(),
      });

    if (insertError) {
      console.error("Insert OTP error:", insertError);
      return res.status(500).json({ error: "Failed to generate reset code" });
    }

    // Send email with OTP
    const emailSent = await sendOTPEmail(normalizedEmail, otp);

    if (!emailSent) {
      console.error(`Failed to send email to ${normalizedEmail}`);
      // Still return success to user (don't reveal email failure)
      return res.json({
        message:
          "If your email is registered, you will receive a reset code. Please check your spam folder.",
      });
    }

    console.log(`✅ Reset email sent to ${normalizedEmail}`);
    res.json({
      message:
        "Reset code sent to your email. Please check your inbox and spam folder.",
    });
  } catch (error) {
    console.error("Forgot password error:", error);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// Step 2: Verify OTP
app.post("/api/auth/verify-reset-otp", async (req, res) => {
  const { email, otp } = req.body;

  if (!email || !otp) {
    return res.status(400).json({ error: "Email and code required" });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const normalizedOtp = otp.trim();

  console.log(`Verifying OTP for ${normalizedEmail}`);

  try {
    const { data: record, error } = await supabase
      .from("password_resets")
      .select("*")
      .eq("email", normalizedEmail)
      .eq("otp", normalizedOtp)
      .eq("used", false)
      .single();

    if (error || !record) {
      console.log("Invalid OTP:", error);
      return res.status(400).json({ error: "Invalid or expired code" });
    }

    if (new Date(record.expires_at) < new Date()) {
      console.log("Expired OTP for:", normalizedEmail);
      return res
        .status(400)
        .json({ error: "Code has expired. Please request a new one." });
    }

    // Mark as used
    await supabase
      .from("password_resets")
      .update({ used: true })
      .eq("id", record.id);

    console.log(`✅ OTP verified successfully for ${normalizedEmail}`);
    res.json({ valid: true });
  } catch (error) {
    console.error("Verify OTP error:", error);
    res.status(500).json({ error: "Verification failed" });
  }
});

// Step 3: Reset Password
app.post("/api/auth/reset-password", async (req, res) => {
  const { email, otp, new_password } = req.body;

  if (!email || !otp || !new_password) {
    return res.status(400).json({ error: "All fields required" });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const normalizedOtp = otp.trim();

  console.log(`Resetting password for ${normalizedEmail}`);

  try {
    // Verify OTP again (must be used = true from previous step)
    const { data: record, error } = await supabase
      .from("password_resets")
      .select("*")
      .eq("email", normalizedEmail)
      .eq("otp", normalizedOtp)
      .eq("used", true)
      .single();

    if (error || !record) {
      console.log("Invalid reset session:", error);
      return res
        .status(400)
        .json({ error: "Invalid or expired reset session" });
    }

    if (new Date(record.expires_at) < new Date()) {
      return res.status(400).json({
        error: "Reset session has expired. Please request a new code.",
      });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(new_password, 10);

    // Update user password
    const { error: updateError } = await supabase
      .from("users")
      .update({
        password_hash: hashedPassword,
        updated_at: new Date().toISOString(),
      })
      .eq("email", normalizedEmail);

    if (updateError) {
      console.error("Password update error:", updateError);
      return res.status(500).json({ error: "Failed to update password" });
    }

    // Delete the used OTP record (cleanup)
    await supabase.from("password_resets").delete().eq("id", record.id);

    console.log(`✅ Password reset successfully for ${normalizedEmail}`);
    res.json({
      message:
        "Password reset successful. You can now login with your new password.",
    });
  } catch (error) {
    console.error("Reset password error:", error);
    res.status(500).json({ error: "Failed to reset password" });
  }
});

// ==================== SIMPLIFIED EMAIL FUNCTION ====================

async function sendOTPEmail(email, otp) {
  console.log(`📧 Attempting to send OTP ${otp} to ${email}`);

  // Check SMTP configuration
  if (
    !process.env.SMTP_HOST ||
    !process.env.SMTP_USER ||
    !process.env.SMTP_PASS
  ) {
    console.error("❌ SMTP credentials missing. Email not sent.");
    return false;
  }

  try {
    // Simple HTML email (works with all providers)
    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>FEECENT Password Reset</title>
      </head>
      <body style="font-family: Arial, sans-serif; margin: 0; padding: 20px; background: #f5f5f5;">
        <div style="max-width: 500px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden;">
          <div style="background: #6b21a8; padding: 20px; text-align: center;">
            <h1 style="color: white; margin: 0;">FEECENT</h1>
            <p style="color: #d8b4fe; margin: 5px 0 0;">Secure Digital Banking</p>
          </div>
          
          <div style="padding: 30px 20px;">
            <h2 style="color: #333; margin-top: 0;">Password Reset</h2>
            <p style="color: #666;">Your verification code is:</p>
            
            <div style="background: #f8fafc; padding: 20px; text-align: center; margin: 20px 0; border-radius: 8px;">
              <span style="font-size: 42px; font-weight: bold; letter-spacing: 8px; color: #6b21a8; font-family: monospace;">${otp}</span>
            </div>
            
            <p style="color: #666; font-size: 14px;">This code expires in <strong>10 minutes</strong>.</p>
            <p style="color: #999; font-size: 12px; margin-top: 20px;">If you didn't request this, please ignore this email.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    const mailOptions = {
      from: `"FEECENT" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
      to: email,
      subject: "FEECENT Password Reset Code",
      html: htmlContent,
      text: `Your FEECENT password reset code is: ${otp}. Valid for 10 minutes.`,
    };

    const info = await transporter.sendMail(mailOptions);
    console.log(`✅ Email sent to ${email}, Message ID: ${info.messageId}`);
    return true;
  } catch (error) {
    console.error("❌ Email error:", error.message);
    return false;
  }
}

// Verify 2FA
app.post("/api/auth/verify-2fa", async (req, res) => {
  try {
    const { userId, token } = req.body;

    const { data: user } = await supabase
      .from("users")
      .select("*")
      .eq("id", userId)
      .single();

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const verified = speakeasy.totp.verify({
      secret: user.two_factor_secret,
      encoding: "base32",
      token,
    });

    if (!verified) {
      return res.status(401).json({ error: "Invalid 2FA token" });
    }

    const jwtToken = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRE },
    );

    res.json({
      token: jwtToken,
      user: {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("2FA verification error:", error);
    res.status(500).json({ error: "Verification failed" });
  }
});

// TEMPORARY DEBUG ROUTE - Put this FIRST
app.get("/api/test", (req, res) => {
  res.json({ message: "Server is working!", time: new Date().toISOString() });
});

// ==================== USER DASHBOARD ROUTES ====================

// Get user profile - Updated with all fields
app.get("/api/user/profile", authenticate, async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from("users")
      .select(
        `
        id,
        email,
        first_name,
        last_name,
        middle_name,
        phone,
        date_of_birth,
        age,
        gender,
        marital_status,
        occupation,
        referral_code,
        address,
        city,
        state,
        country,
        postal_code,
        identification_type,
        identification_number,
        kyc_status,
        two_factor_enabled,
        is_frozen,
        freeze_reason,
        face_verified,
        face_verification_date,
        created_at,
        updated_at
      `,
      )
      .eq("id", req.user.id)
      .single();

    if (error) {
      console.error("Profile fetch error:", error);
      return res.status(500).json({ error: "Failed to fetch profile" });
    }

    // Get face descriptor count (for UI display)
    const { count: faceCount, error: faceCountError } = await supabase
      .from("face_descriptors")
      .select("*", { count: "exact", head: true })
      .eq("user_id", req.user.id)
      .eq("is_active", true);

    if (faceCountError) {
      console.error("Face count error:", faceCountError);
    }

    // Check if user has passcode set
    const { data: passcodeCheck, error: passcodeError } = await supabase
      .from("users")
      .select("passcode_hash")
      .eq("id", req.user.id)
      .single();

    const hasPasscode = passcodeCheck && passcodeCheck.passcode_hash !== null;

    console.log("Profile fetched for user:", user.id);
    console.log("Face verified:", user.face_verified);
    console.log("Has passcode:", hasPasscode);

    res.json({
      ...user,
      has_passcode: hasPasscode,
      face_descriptor_count: faceCount || 0,
    });
  } catch (error) {
    console.error("Profile fetch error:", error);
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

// Update profile
app.put("/api/user/profile", authenticate, async (req, res) => {
  try {
    const {
      first_name,
      last_name,
      phone,
      address,
      city,
      country,
      postal_code,
    } = req.body;

    const { data: user, error } = await supabase
      .from("users")
      .update({
        first_name,
        last_name,
        phone,
        address,
        city,
        country,
        postal_code,
        updated_at: new Date(),
      })
      .eq("id", req.user.id)
      .select()
      .single();

    if (error) throw error;

    res.json({ message: "Profile updated successfully", user });
  } catch (error) {
    console.error("Profile update error:", error);
    res.status(500).json({ error: "Failed to update profile" });
  }
});

// Change password

app.post("/api/user/change-password", authenticate, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;

    console.log("=== CHANGE PASSWORD REQUEST ===");
    console.log("User ID:", req.user?.id);
    console.log("User email:", req.user?.email);

    // IMPORTANT: Fetch fresh user data from database to ensure we have the password hash
    const { data: user, error: fetchError } = await supabase
      .from("users")
      .select("id, email, password_hash, first_name, last_name")
      .eq("id", req.user.id)
      .single();

    if (fetchError || !user) {
      console.error("User fetch error:", fetchError);
      return res.status(404).json({ error: "User not found" });
    }

    console.log("User found, has password hash:", !!user.password_hash);

    // Verify current password
    if (!user.password_hash) {
      console.error("No password hash found for user");
      return res.status(500).json({ error: "Account setup incomplete" });
    }

    const validPassword = await bcrypt.compare(
      current_password,
      user.password_hash,
    );
    if (!validPassword) {
      console.log("Current password incorrect for user:", user.email);
      return res.status(401).json({ error: "Current password is incorrect" });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(new_password, 10);

    // Update password
    const { error: updateError } = await supabase
      .from("users")
      .update({
        password_hash: hashedPassword,
        updated_at: new Date().toISOString(),
      })
      .eq("id", req.user.id);

    if (updateError) {
      console.error("Password update error:", updateError);
      return res.status(500).json({ error: "Failed to update password" });
    }

    console.log("Password changed successfully for user:", user.email);
    res.json({ message: "Password changed successfully" });
  } catch (error) {
    console.error("Password change error:", error);
    res
      .status(500)
      .json({ error: "Failed to change password: " + error.message });
  }
});

// Enable 2FA
app.post("/api/user/enable-2fa", authenticate, async (req, res) => {
  try {
    const secret = speakeasy.generateSecret({
      name: `BankApp:${req.user.email}`,
    });

    // Save secret to user
    await supabase
      .from("users")
      .update({ two_factor_secret: secret.base32 })
      .eq("id", req.user.id);

    // Generate QR code
    const qrCode = await QRCode.toDataURL(secret.otpauth_url);

    res.json({ secret: secret.base32, qrCode });
  } catch (error) {
    console.error("2FA enable error:", error);
    res.status(500).json({ error: "Failed to enable 2FA" });
  }
});

// Verify and activate 2FA
app.post("/api/user/verify-enable-2fa", authenticate, async (req, res) => {
  try {
    const { token } = req.body;

    const verified = speakeasy.totp.verify({
      secret: req.user.two_factor_secret,
      encoding: "base32",
      token,
    });

    if (!verified) {
      return res.status(401).json({ error: "Invalid token" });
    }

    await supabase
      .from("users")
      .update({ two_factor_enabled: true })
      .eq("id", req.user.id);

    res.json({ message: "2FA enabled successfully" });
  } catch (error) {
    console.error("2FA verification error:", error);
    res.status(500).json({ error: "Failed to verify 2FA" });
  }
});

// Disable 2FA
app.post("/api/user/disable-2fa", authenticate, async (req, res) => {
  try {
    await supabase
      .from("users")
      .update({
        two_factor_enabled: false,
        two_factor_secret: null,
      })
      .eq("id", req.user.id);

    res.json({ message: "2FA disabled successfully" });
  } catch (error) {
    console.error("2FA disable error:", error);
    res.status(500).json({ error: "Failed to disable 2FA" });
  }
});

// Get accounts and balances (allow frozen users to see balance)
app.get("/api/user/accounts", authenticate, async (req, res) => {
  try {
    const { data: accounts, error } = await supabase
      .from("accounts")
      .select("*")
      .eq("user_id", req.user.id);

    if (error) throw error;

    res.json(accounts);
  } catch (error) {
    console.error("Accounts fetch error:", error);
    res.status(500).json({ error: "Failed to fetch accounts" });
  }
});

// Get transactions with user details
/*app.get(
  "/api/user/transactions",
  authenticate,
  checkAccountFrozen,
  async (req, res) => {
    try {
      const { page = 1, limit = 20, start_date, end_date, type } = req.query;
      const offset = (parseInt(page) - 1) * parseInt(limit);

      // Get user's account IDs first (lighter query)
      const { data: accounts, error: accountsError } = await supabase
        .from("accounts")
        .select("id")
        .eq("user_id", req.user.id);

      if (accountsError) throw accountsError;

      const accountIds = accounts.map((a) => a.id);

      if (accountIds.length === 0) {
        return res.json({
          transactions: [],
          pagination: { page: 1, limit: 20, total: 0, pages: 0 },
        });
      }

      // Build query - use OR condition properly
      let query = supabase
        .from("transactions")
        .select(
          "id, transaction_id, amount, description, transaction_type, status, created_at, completed_at, from_account_id, to_account_id, from_user_id, to_user_id",
          { count: "exact" },
        )
        .or(
          `from_account_id.in.(${accountIds.join(",")}),to_account_id.in.(${accountIds.join(",")})`,
        )
        .order("created_at", { ascending: false });

      // Apply filters
      if (start_date) {
        query = query.gte("created_at", start_date);
      }
      if (end_date) {
        query = query.lte("created_at", `${end_date}T23:59:59`);
      }
      if (type && type !== "all") {
        query = query.eq("transaction_type", type);
      }

      const {
        data: transactions,
        error,
        count,
      } = await query.range(offset, offset + parseInt(limit) - 1);

      if (error) throw error;

      // Get user details separately (only for displayed transactions)
      const userIds = new Set();
      transactions.forEach((t) => {
        if (t.from_user_id) userIds.add(t.from_user_id);
        if (t.to_user_id) userIds.add(t.to_user_id);
      });

      let userDetails = {};
      if (userIds.size > 0) {
        const { data: users } = await supabase
          .from("users")
          .select("id, first_name, last_name, email")
          .in("id", [...userIds]);

        userDetails = (users || []).reduce((acc, u) => {
          acc[u.id] = u;
          return acc;
        }, {});
      }

      // Get account details
      const accountIdsSet = new Set();
      transactions.forEach((t) => {
        if (t.from_account_id) accountIdsSet.add(t.from_account_id);
        if (t.to_account_id) accountIdsSet.add(t.to_account_id);
      });

      let accountDetails = {};
      if (accountIdsSet.size > 0) {
        const { data: accountsData } = await supabase
          .from("accounts")
          .select("id, account_number, account_type")
          .in("id", [...accountIdsSet]);

        accountDetails = (accountsData || []).reduce((acc, a) => {
          acc[a.id] = a;
          return acc;
        }, {});
      }

      // Combine data
      const enrichedTransactions = transactions.map((t) => ({
        ...t,
        from_user: userDetails[t.from_user_id] || null,
        to_user: userDetails[t.to_user_id] || null,
        from_account: accountDetails[t.from_account_id] || null,
        to_account: accountDetails[t.to_account_id] || null,
      }));

      res.json({
        transactions: enrichedTransactions,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: count || 0,
          pages: Math.ceil((count || 0) / parseInt(limit)),
        },
      });
    } catch (error) {
      console.error("Transactions fetch error:", error);
      res.status(500).json({ error: "Failed to fetch transactions" });
    }
  },
);

// Get single transaction details for receipt viewing
app.get(
  "/api/user/transactions/:transactionId",
  authenticate,
  async (req, res) => {
    try {
      const { transactionId } = req.params;

      const { data: transaction, error } = await supabase
        .from("transactions")
        .select(
          `
          *,
          from_account:accounts!transactions_from_account_id_fkey(id, account_number),
          to_account:accounts!transactions_to_account_id_fkey(id, account_number),
          from_user:users!transactions_from_user_id_fkey(id, first_name, last_name, email),
          to_user:users!transactions_to_user_id_fkey(id, first_name, last_name, email)
        `,
        )
        .eq("id", transactionId)
        .single();

      if (error) throw error;

      // Verify user owns this transaction
      if (
        transaction.from_user_id !== req.user.id &&
        transaction.to_user_id !== req.user.id
      ) {
        return res.status(403).json({ error: "Access denied" });
      }

      res.json(transaction);
    } catch (error) {
      console.error("Transaction fetch error:", error);
      res.status(500).json({ error: "Failed to fetch transaction" });
    }
  },
);*/

app.get(
  "/api/user/transactions",
  authenticate,
  checkAccountFrozen,
  async (req, res) => {
    try {
      const { page = 1, limit = 20, start_date, end_date, type } = req.query;
      const offset = (parseInt(page) - 1) * parseInt(limit);

      // Get user's account IDs
      const { data: accounts, error: accountsError } = await supabase
        .from("accounts")
        .select("id")
        .eq("user_id", req.user.id);

      if (accountsError) throw accountsError;

      const accountIds = accounts.map((a) => a.id);

      if (accountIds.length === 0) {
        return res.json({
          transactions: [],
          pagination: { page: 1, limit: 20, total: 0, pages: 0 },
        });
      }

      // UPDATED QUERY: Only show completed transactions to receiver
      // For failed transactions, only show if user is sender
      let query = supabase
        .from("transactions")
        .select(
          "id, transaction_id, amount, description, transaction_type, status, created_at, completed_at, from_account_id, to_account_id, from_user_id, to_user_id, failed_reason",
          { count: "exact" },
        )
        .or(
          `from_account_id.in.(${accountIds.join(",")}),` +
            `(to_account_id.in.(${accountIds.join(",")}) AND status = 'completed')`, // Only show completed to receiver
        )
        .order("created_at", { ascending: false });

      // Apply filters
      if (start_date) {
        query = query.gte("created_at", start_date);
      }
      if (end_date) {
        query = query.lte("created_at", `${end_date}T23:59:59`);
      }
      if (type && type !== "all") {
        query = query.eq("transaction_type", type);
      }

      const {
        data: transactions,
        error,
        count,
      } = await query.range(offset, offset + parseInt(limit) - 1);

      if (error) throw error;

      // ... rest of the function remains the same
    } catch (error) {
      console.error("Transactions fetch error:", error);
      res.status(500).json({ error: "Failed to fetch transactions" });
    }
  },
);

app.get(
  "/api/user/transactions/:transactionId",
  authenticate,
  async (req, res) => {
    try {
      const { transactionId } = req.params;

      const { data: transaction, error } = await supabase
        .from("transactions")
        .select(
          `
          *,
          from_account:accounts!transactions_from_account_id_fkey(id, account_number),
          to_account:accounts!transactions_to_account_id_fkey(id, account_number),
          from_user:users!transactions_from_user_id_fkey(id, first_name, last_name, email),
          to_user:users!transactions_to_user_id_fkey(id, first_name, last_name, email)
        `,
        )
        .eq("id", transactionId)
        .single();

      if (error) throw error;

      // Verify user owns this transaction (only sender can see failed transactions)
      if (
        transaction.status === "failed" ||
        transaction.status === "rejected"
      ) {
        // Only the sender can see failed transactions
        if (transaction.from_user_id !== req.user.id) {
          return res.status(403).json({ error: "Access denied" });
        }
      } else {
        // For completed/pending, both parties can view
        if (
          transaction.from_user_id !== req.user.id &&
          transaction.to_user_id !== req.user.id
        ) {
          return res.status(403).json({ error: "Access denied" });
        }
      }

      res.json(transaction);
    } catch (error) {
      console.error("Transaction fetch error:", error);
      res.status(500).json({ error: "Failed to fetch transaction" });
    }
  },
);

// Download statement
app.get(
  "/api/user/statements",
  authenticate,
  checkAccountFrozen,
  async (req, res) => {
    try {
      const { account_id, start_date, end_date, format = "csv" } = req.query;

      // Verify account belongs to user
      const { data: account } = await supabase
        .from("accounts")
        .select("*")
        .eq("id", account_id)
        .eq("user_id", req.user.id)
        .single();

      if (!account) {
        return res.status(404).json({ error: "Account not found" });
      }

      // Get transactions
      const { data: transactions } = await supabase
        .from("transactions")
        .select("*")
        .or(`from_account_id.eq.${account_id},to_account_id.eq.${account_id}`)
        .gte("created_at", start_date)
        .lte("created_at", end_date)
        .order("created_at", { ascending: true });

      if (format === "csv") {
        // Generate CSV
        let csv = "Date,Description,Type,Amount,Balance\n";
        let balance = 0;

        transactions.forEach((t) => {
          const isCredit = t.to_account_id === account_id;
          const amount = isCredit ? t.amount : -t.amount;
          balance += amount;

          csv += `${t.created_at},${t.description},${isCredit ? "Credit" : "Debit"},${amount},${balance}\n`;
        });

        res.setHeader("Content-Type", "text/csv");
        res.setHeader(
          "Content-Disposition",
          "attachment; filename=statement.csv",
        );
        res.send(csv);
      } else {
        // Return JSON
        res.json(transactions);
      }
    } catch (error) {
      console.error("Statement generation error:", error);
      res.status(500).json({ error: "Failed to generate statement" });
    }
  },
);

// Enhanced transfer with device trust and recipient checking - WITH EARLY FAILURE RECORDING
app.post(
  "/api/user/transfer",
  authenticate,
  checkAccountFrozen,
  transferLimiter,
  async (req, res) => {
    let failedRecordId = null;

    try {
      const {
        from_account_id,
        to_account_number,
        amount,
        description,
        device_fingerprint,
        skip_security_check = false,
        requires_otp = false,
      } = req.body;

      // Get user agent and IP for logging
      const userAgent = req.headers["user-agent"];
      const ip =
        req.ip ||
        req.connection.remoteAddress ||
        req.headers["x-forwarded-for"];

      // ========== STEP 1: CREATE INITIAL FAILED RECORD (in case anything fails) ==========
      const initialRecord = await createInitialFailedTransactionRecord(
        req.user.id,
        from_account_id,
        to_account_number,
        amount,
        description,
        ip,
        userAgent,
      );
      if (initialRecord) {
        failedRecordId = initialRecord.id;
      }

      // ========== VALIDATION CHECKS ==========

      // Validate amount
      if (!amount || amount <= 0) {
        if (failedRecordId) {
          await updateFailedTransactionRecord(
            failedRecordId,
            "Invalid amount",
            "validation_error",
          );
        }
        return res.status(400).json({ error: "Invalid amount" });
      }

      // Get source account
      const { data: fromAccount, error: fromError } = await supabase
        .from("accounts")
        .select("*, users!inner(id, email, first_name, last_name, phone)")
        .eq("id", from_account_id)
        .eq("user_id", req.user.id)
        .single();

      if (fromError || !fromAccount) {
        if (failedRecordId) {
          await updateFailedTransactionRecord(
            failedRecordId,
            "Source account not found",
            "account_error",
          );
        }
        return res.status(404).json({ error: "Source account not found" });
      }

      // Check balance
      /*if (fromAccount.available_balance < amount) {
        console.log(
          `❌ Balance check failed: Available: ${fromAccount.available_balance}, Required: ${amount}`,
        );

        if (failedRecordId) {
          // Update the failed record with the correct reason
          const failureReason = `Insufficient balance. Available: ₦${fromAccount.available_balance.toLocaleString()}, Required: ₦${amount.toLocaleString()}`;

          const { error: updateError } = await supabase
            .from("transactions")
            .update({
              failed_reason: failureReason,
              failure_type: "balance_error",
              description: `Failed transfer - Insufficient funds. Available: ₦${fromAccount.available_balance.toLocaleString()}, Required: ₦${amount.toLocaleString()}`,
              status: "failed",
              completed_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("id", failedRecordId);

          if (updateError) {
            console.error("Failed to update failed record:", updateError);
          } else {
            console.log(
              `✅ Updated failed record ${failedRecordId} with balance error`,
            );

            // Verify the update worked by fetching the record
            const { data: verified } = await supabase
              .from("transactions")
              .select("failed_reason")
              .eq("id", failedRecordId)
              .single();

            console.log(`Verified failure reason: ${verified?.failed_reason}`);
          }
        }

        return res.status(400).json({
          error: "Insufficient funds",
          failed_record_id: failedRecordId,
          available_balance: fromAccount.available_balance,
          required_amount: amount,
        });
      }*/

      // In index.js - REPLACE your entire balance check section with this

      // ========== BALANCE CHECK WITH DIRECT DATABASE UPDATE ==========
      if (fromAccount.available_balance < amount) {
        console.log(
          `❌ INSUFFICIENT BALANCE: User ${req.user.id}, Available: ${fromAccount.available_balance}, Required: ${amount}`,
        );

        let finalTransactionUuid = null;
        const failureReason = `Insufficient balance. Available: ₦${fromAccount.available_balance.toLocaleString()}, Required: ₦${amount.toLocaleString()}`;

        // Check if we have a pending record ID from earlier
        if (failedRecordId) {
          console.log(`📝 Updating existing pending record: ${failedRecordId}`);

          // DIRECT UPDATE - NO HELPER FUNCTION
          const { error: updateError } = await supabase
            .from("transactions")
            .update({
              status: "failed",
              failed_reason: failureReason,
              failure_type: "balance_error",
              description: `Failed transfer - Insufficient funds. Available: ₦${fromAccount.available_balance.toLocaleString()}, Required: ₦${amount.toLocaleString()}`,
              completed_at: new Date().toISOString(),
            })
            .eq("id", failedRecordId);

          if (updateError) {
            console.error("❌ Update failed:", updateError);
          } else {
            console.log(
              `✅ Successfully updated record ${failedRecordId} with balance error`,
            );
            finalTransactionUuid = failedRecordId;

            // VERIFY the update worked
            const { data: verify } = await supabase
              .from("transactions")
              .select("failed_reason, status")
              .eq("id", failedRecordId)
              .single();

            console.log(
              `🔍 Verification - Status: ${verify?.status}, Reason: ${verify?.failed_reason}`,
            );
          }
        } else {
          // Create a brand new failed record
          console.log(`📝 Creating new failed record for balance error`);

          const transactionId = `FAIL${Date.now()}${Math.floor(Math.random() * 10000)}`;

          const { data: newRecord, error: insertError } = await supabase
            .from("transactions")
            .insert({
              transaction_id: transactionId,
              from_account_id: from_account_id,
              to_account_id: toAccount?.id || null,
              from_user_id: req.user.id,
              to_user_id: toAccount?.user_id || null,
              amount: amount,
              fee_amount: 0,
              description: description || `Transfer to ${to_account_number}`,
              transaction_type: "transfer",
              status: "failed",
              failed_reason: failureReason,
              failure_type: "balance_error",
              created_at: new Date().toISOString(),
              completed_at: new Date().toISOString(),
              ip_address: ip,
              user_agent: userAgent,
            })
            .select()
            .single();

          if (insertError) {
            console.error("❌ Failed to create failed record:", insertError);
          } else {
            console.log(`✅ Created new failed record: ${newRecord.id}`);
            finalTransactionUuid = newRecord.id;
          }
        }

        // Return the response with the record ID
        return res.status(400).json({
          error: "Insufficient funds",
          failed_record_id: finalTransactionUuid,
          failed_record_uuid: finalTransactionUuid,
          available_balance: fromAccount.available_balance,
          required_amount: amount,
        });
      }

      // Get destination account
      const { data: toAccount, error: toError } = await supabase
        .from("accounts")
        .select("*, users!inner(id, email, first_name, last_name, is_frozen)")
        .eq("account_number", to_account_number)
        .single();

      if (toError || !toAccount) {
        if (failedRecordId) {
          await updateFailedTransactionRecord(
            failedRecordId,
            "Destination account not found",
            "account_error",
          );
        }
        return res.status(404).json({ error: "Destination account not found" });
      }

      // Update the failed record with correct to_account_id and to_user_id
      if (failedRecordId) {
        await supabase
          .from("transactions")
          .update({
            to_account_id: toAccount.id,
            to_user_id: toAccount.user_id,
          })
          .eq("id", failedRecordId);
      }

      // Prevent self-transfer
      if (toAccount.user_id === req.user.id) {
        if (failedRecordId) {
          await updateFailedTransactionRecord(
            failedRecordId,
            "Cannot transfer to own account",
            "validation_error",
          );
        }
        return res
          .status(400)
          .json({ error: "Cannot transfer to your own account" });
      }

      // Check if destination account is frozen
      if (toAccount.users?.is_frozen) {
        if (failedRecordId) {
          await updateFailedTransactionRecord(
            failedRecordId,
            "Destination account frozen",
            "account_frozen",
          );
        }
        return res.status(400).json({ error: "Destination account is frozen" });
      }

      // ========== SECURITY CHECKS ==========

      // 1. Update device trust tracking
      const deviceTrust = await updateDeviceTrust(
        req.user.id,
        device_fingerprint || req.headers["user-agent"],
        req.headers["user-agent"],
        req.ip,
      );

      // 2. Get user's current transfer threshold
      const userThreshold = await getUserTransferThreshold(
        req.user.id,
        device_fingerprint || req.headers["user-agent"],
      );

      // 3. Check if this is a large transfer (over ₦200,000)
      const isLargeTransfer = amount > 200000;

      // 4. Check if recipient is new (first time transfer)
      const isNewRecipient = !(await hasTransferredToBefore(
        req.user.id,
        to_account_number,
      ));

      // 5. Check if amount exceeds device threshold
      const exceedsThreshold = amount > userThreshold.threshold;

      // ========== SECURITY RESPONSES WITH FAILURE RECORDING ==========

      // Case 1: New device with amount above threshold
      if (
        !skip_security_check &&
        exceedsThreshold &&
        userThreshold.reason === "new_device"
      ) {
        if (failedRecordId) {
          await updateFailedTransactionRecord(
            failedRecordId,
            `New device limit: ₦${userThreshold.threshold.toLocaleString()}`,
            "security_new_device",
            {
              threshold: userThreshold.threshold,
              device_age: userThreshold.deviceAge,
            },
          );
        }

        return res.status(403).json({
          error: "new_device_limit",
          message: `This device is not yet trusted. For security, transfers are limited to ₦${userThreshold.threshold.toLocaleString()} on new devices.`,
          threshold: userThreshold.threshold,
          device_age: userThreshold.deviceAge,
          required_days: 2 - (userThreshold.deviceAge || 0),
          reason: "new_device",
          failed_record_id: failedRecordId,
        });
      }

      // Case 2: New recipient - require confirmation (not a failure yet)
      if (!skip_security_check && isNewRecipient) {
        // This is not a failure, just pending confirmation
        if (failedRecordId) {
          await updateFailedTransactionRecord(
            failedRecordId,
            "Awaiting new recipient confirmation",
            "pending_confirmation",
          );
        }

        return res.status(403).json({
          error: "new_recipient",
          message:
            "You haven't transferred to this recipient before. Please verify their details carefully.",
          recipient: {
            name: `${toAccount.users?.first_name || ""} ${toAccount.users?.last_name || ""}`.trim(),
            account_number: to_account_number,
          },
          require_confirmation: true,
          failed_record_id: failedRecordId,
        });
      }

      // Case 3: Large transfer - require confirmation
      if (!skip_security_check && isLargeTransfer) {
        if (failedRecordId) {
          await updateFailedTransactionRecord(
            failedRecordId,
            "Awaiting large transfer confirmation",
            "pending_confirmation",
          );
        }

        return res.status(403).json({
          error: "large_transfer",
          message: `You are about to transfer ₦${amount.toLocaleString()}. Please verify the recipient details carefully to avoid errors.`,
          recipient: {
            name: `${toAccount.users?.first_name || ""} ${toAccount.users?.last_name || ""}`.trim(),
            account_number: to_account_number,
          },
          amount: amount,
          require_confirmation: true,
          failed_record_id: failedRecordId,
        });
      }

      // ========== CONTINUE WITH NORMAL TRANSFER PROCESSING ==========

      // If we get here, delete the failed record since transfer will succeed
      if (failedRecordId) {
        await supabase.from("transactions").delete().eq("id", failedRecordId);
        failedRecordId = null;
      }

      // Calculate fee
      let feeAmount = 0;
      if (amount >= 10000) {
        feeAmount = 50;
      }

      const totalDeduction = amount + feeAmount;

      // Final balance check
      if (fromAccount.available_balance < totalDeduction) {
        // Re-create failed record since balance check failed
        const newFailedRecord = await createInitialFailedTransactionRecord(
          req.user.id,
          from_account_id,
          to_account_number,
          amount,
          description,
          ip,
          userAgent,
        );
        if (newFailedRecord) {
          await updateFailedTransactionRecord(
            newFailedRecord.id,
            "Insufficient funds after fee calculation",
            "balance_error",
            {
              available_balance: fromAccount.available_balance,
              amount: totalDeduction,
            },
          );
        }
        return res.status(400).json({
          error: `Insufficient funds. Amount: ₦${amount} + Fee: ₦${feeAmount} = ₦${totalDeduction}`,
        });
      }

      // Generate transaction ID
      const transactionId = `TXN${Date.now()}${Math.floor(Math.random() * 10000)}`;

      // Create transaction record
      const transactionData = {
        transaction_id: transactionId,
        from_account_id,
        to_account_id: toAccount.id,
        from_user_id: req.user.id,
        to_user_id: toAccount.user_id,
        amount: amount,
        fee_amount: feeAmount,
        description: description || `Transfer to ${toAccount.account_number}`,
        transaction_type: "transfer",
        status: "pending",
        created_at: new Date().toISOString(),
      };

      // Check for OTP requirement
      const isLargeAmount = amount > 500000;
      const needsOTP = requires_otp || isLargeAmount;

      if (needsOTP && process.env.OTP_MODE === "on") {
        transactionData.requires_otp = true;

        const { data: transaction, error: txError } = await supabase
          .from("transactions")
          .insert(transactionData)
          .select()
          .single();

        if (txError) throw txError;

        const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

        await supabase.from("otps").insert({
          user_id: req.user.id,
          transaction_id: transaction.id,
          otp_code: otpCode,
          otp_type: "transfer",
          expires_at: expiresAt,
        });

        await sendOTPEmail(fromAccount.users.email, otpCode);

        return res.json({
          message: "OTP required to complete transfer",
          requires_otp: true,
          transaction_id: transaction.id,
        });
      }

      // Process transfer immediately
      transactionData.status = "completed";
      transactionData.completed_at = new Date().toISOString();

      const { data: transaction, error: txError } = await supabase
        .from("transactions")
        .insert(transactionData)
        .select()
        .single();

      if (txError) throw txError;

      // Update balances
      const newSenderBalance = fromAccount.balance - totalDeduction;
      const newSenderAvailable = fromAccount.available_balance - totalDeduction;

      await supabase
        .from("accounts")
        .update({
          balance: newSenderBalance,
          available_balance: newSenderAvailable,
          updated_at: new Date().toISOString(),
        })
        .eq("id", from_account_id);

      const newReceiverBalance = toAccount.balance + amount;
      const newReceiverAvailable = toAccount.available_balance + amount;

      await supabase
        .from("accounts")
        .update({
          balance: newReceiverBalance,
          available_balance: newReceiverAvailable,
          updated_at: new Date().toISOString(),
        })
        .eq("id", toAccount.id);

      // Create notifications
      await createNotification(
        req.user.id,
        "Transfer Completed",
        `You transferred ₦${amount.toLocaleString()} to ${toAccount.account_number}. Fee: ₦${feeAmount}`,
        "success",
      );

      await createNotification(
        toAccount.user_id,
        "Money Received",
        `You received ₦${amount.toLocaleString()} from ${fromAccount.users.first_name} ${fromAccount.users.last_name}`,
        "success",
      );

      // Log successful transfer
      await logSecurityEvent(req.user.id, "transfer_completed", {
        amount,
        to_account: toAccount.account_number,
        transaction_id: transaction.id,
      });

      res.json({
        message: "Transfer completed successfully",
        transaction: {
          id: transaction.id,
          transaction_id: transaction.transaction_id,
          amount: amount,
          fee: feeAmount,
          total_deducted: totalDeduction,
          new_balance: newSenderAvailable,
          description: transaction.description,
          completed_at: transaction.completed_at,
        },
        recipient: {
          name: `${toAccount.users?.first_name || ""} ${toAccount.users?.last_name || ""}`.trim(),
          account_number: toAccount.account_number,
        },
      });
    } catch (error) {
      console.error("Transfer error:", error);

      // Update the failed record if it exists
      if (failedRecordId) {
        await updateFailedTransactionRecord(
          failedRecordId,
          error.message || "Internal server error",
          "server_error",
        );
      } else {
        // Create a new failed record
        const newFailedRecord = await createInitialFailedTransactionRecord(
          req.user.id,
          req.body.from_account_id,
          req.body.to_account_number,
          req.body.amount,
          req.body.description,
          req.ip,
          req.headers["user-agent"],
        );
        if (newFailedRecord) {
          await updateFailedTransactionRecord(
            newFailedRecord.id,
            error.message || "Internal server error",
            "server_error",
          );
        }
      }

      await logSecurityEvent(req.user.id, "transfer_failed", {
        error: error.message,
      });
      res.status(500).json({ error: "Transfer failed: " + error.message });
    }
  },
);

// In index.js - Fix the createInitialFailedTransactionRecord function
/*async function createInitialFailedTransactionRecord(
  userId,
  fromAccountId,
  toAccountNumber,
  amount,
  description,
  ip,
  userAgent,
) {
  try {
    // Get the source account details
    const { data: fromAccount } = await supabase
      .from("accounts")
      .select("account_number, user_id")
      .eq("id", fromAccountId)
      .single();

    // Try to get destination account info if it exists
    let toAccountId = null;
    let toUserId = null;
    let toAccountNumberDisplay = toAccountNumber;

    const { data: toAccount } = await supabase
      .from("accounts")
      .select("id, user_id, account_number")
      .eq("account_number", toAccountNumber)
      .maybeSingle();

    if (toAccount) {
      toAccountId = toAccount.id;
      toUserId = toAccount.user_id;
      toAccountNumberDisplay = toAccount.account_number;
    }

    const transactionId = `FAIL${Date.now()}${Math.floor(Math.random() * 10000)}`;

    const transactionData = {
      transaction_id: transactionId,
      from_account_id: fromAccountId,
      to_account_id: toAccountId,
      from_user_id: userId,
      to_user_id: toUserId,
      amount: amount,
      fee_amount: 0,
      description: description || `Transfer to ${toAccountNumberDisplay}`,
      transaction_type: "transfer",
      status: "failed", // Use pending, not failed - we'll update to failed later
      failed_reason: null, // Start with null
      failure_type: null,
      created_at: new Date().toISOString(),
      ip_address: ip,
      user_agent: userAgent,
    };

    const { data: inserted, error } = await supabase
      .from("transactions")
      .insert(transactionData)
      .select()
      .single();

    if (error) {
      console.error("Failed to create initial record:", error);
      return null;
    }

    console.log(
      `📝 Created initial transaction record: ${transactionId}, Amount: ${amount}, Status: pending`,
    );
    return inserted;
  } catch (error) {
    console.error("Error creating initial record:", error);
    return null;
  }
}*/

async function createInitialFailedTransactionRecord(
  userId,
  fromAccountId,
  toAccountNumber,
  amount,
  description,
  ip,
  userAgent,
) {
  try {
    // Get the source account details
    const { data: fromAccount } = await supabase
      .from("accounts")
      .select("account_number, user_id")
      .eq("id", fromAccountId)
      .single();

    // Try to get destination account info if it exists - BUT DON'T SET to_user_id for failed
    let toAccountId = null;
    let toUserId = null;
    let toAccountNumberDisplay = toAccountNumber;

    const { data: toAccount } = await supabase
      .from("accounts")
      .select("id, user_id, account_number")
      .eq("account_number", toAccountNumber)
      .maybeSingle();

    if (toAccount) {
      toAccountId = toAccount.id;
      // CRITICAL: DON'T set toUserId for failed transactions!
      // This ensures the failed transaction only shows for sender
      toUserId = null; // ← KEY FIX - don't set to_user_id for failed
      toAccountNumberDisplay = toAccount.account_number;
    }

    const transactionId = `FAIL${Date.now()}${Math.floor(Math.random() * 10000)}`;

    const transactionData = {
      transaction_id: transactionId,
      from_account_id: fromAccountId,
      to_account_id: toAccountId,
      from_user_id: userId,
      to_user_id: null, // ← CRITICAL FIX: Set to null for failed transactions
      amount: amount,
      fee_amount: 0,
      description:
        description || `Failed transfer to ${toAccountNumberDisplay}`,
      transaction_type: "transfer",
      status: "failed", // Set to failed directly
      failed_reason: null,
      failure_type: null,
      created_at: new Date().toISOString(),
      ip_address: ip,
      user_agent: userAgent,
    };

    const { data: inserted, error } = await supabase
      .from("transactions")
      .insert(transactionData)
      .select()
      .single();

    if (error) {
      console.error("Failed to create initial record:", error);
      return null;
    }

    console.log(
      `📝 Created initial failed transaction record: ${transactionId}, Amount: ${amount}`,
    );
    return inserted;
  } catch (error) {
    console.error("Error creating initial record:", error);
    return null;
  }
}

async function updateFailedTransactionRecord(
  transactionRecordId,
  reason,
  failureType,
  details = {},
) {
  if (!transactionRecordId) {
    console.error(
      "No transactionRecordId provided to updateFailedTransactionRecord",
    );
    return false;
  }

  try {
    console.log(
      `🔄 Updating failed record ${transactionRecordId}: ${reason} (${failureType})`,
    );

    let finalReason = reason;
    let finalDescription = `Failed transfer - ${reason}`;

    // Build proper messages based on failure type
    if (failureType === "balance_error") {
      finalReason = `Insufficient balance. Available: ₦${details.available_balance?.toLocaleString() || "N/A"}, Required: ₦${details.amount?.toLocaleString() || "N/A"}`;
      finalDescription = `Failed transfer - Insufficient funds. Available: ₦${details.available_balance?.toLocaleString() || "N/A"}, Required: ₦${details.amount?.toLocaleString() || "N/A"}`;
    } else if (failureType === "validation_error") {
      finalReason = reason;
      finalDescription = `Failed transfer - ${reason}`;
    } else if (failureType === "account_error") {
      finalReason = reason;
      finalDescription = `Failed transfer - ${reason}`;
    } else if (failureType === "security_new_device") {
      finalReason = reason;
      finalDescription = `Failed transfer - ${reason}`;
    } else if (failureType === "account_frozen") {
      finalReason = reason;
      finalDescription = `Failed transfer - ${reason}`;
    } else if (failureType === "pin_error") {
      finalReason = reason;
      finalDescription = `Failed transfer - ${reason}`;
    }

    const updates = {
      failed_reason: finalReason,
      failure_type: failureType,
      description: finalDescription,
      status: "failed",
      // CRITICAL: Ensure to_user_id remains null for failed
      to_user_id: null,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase
      .from("transactions")
      .update(updates)
      .eq("id", transactionRecordId);

    if (error) {
      console.error("Failed to update failed record:", error);
      return false;
    }

    console.log(`✅ Successfully updated failed record ${transactionRecordId}`);
    console.log(`   New failure_reason: ${finalReason}`);
    return true;
  } catch (error) {
    console.error("Error updating failed record:", error);
    return false;
  }
}

// In index.js - Completely rewrite the updateFailedTransactionRecord function
/*async function updateFailedTransactionRecord(
  transactionRecordId,
  reason,
  failureType,
  details = {},
) {
  if (!transactionRecordId) {
    console.error(
      "No transactionRecordId provided to updateFailedTransactionRecord",
    );
    return false;
  }

  try {
    console.log(
      `🔄 Updating failed record ${transactionRecordId}: ${reason} (${failureType})`,
    );

    let finalReason = reason;
    let finalDescription = `Failed transfer - ${reason}`;

    // Build proper messages based on failure type
    if (failureType === "balance_error") {
      finalReason = `Insufficient balance. Available: ₦${details.available_balance?.toLocaleString() || "N/A"}, Required: ₦${details.amount?.toLocaleString() || "N/A"}`;
      finalDescription = `Failed transfer - Insufficient funds. Available: ₦${details.available_balance?.toLocaleString() || "N/A"}, Required: ₦${details.amount?.toLocaleString() || "N/A"}`;
    } else if (failureType === "validation_error") {
      finalReason = reason;
      finalDescription = `Failed transfer - ${reason}`;
    } else if (failureType === "account_error") {
      finalReason = reason;
      finalDescription = `Failed transfer - ${reason}`;
    } else if (failureType === "security_new_device") {
      finalReason = reason;
      finalDescription = `Failed transfer - ${reason}`;
    } else if (failureType === "account_frozen") {
      finalReason = reason;
      finalDescription = `Failed transfer - ${reason}`;
    } else if (failureType === "pin_error") {
      finalReason = reason;
      finalDescription = `Failed transfer - ${reason}`;
    }

    const updates = {
      failed_reason: finalReason,
      failure_type: failureType,
      description: finalDescription,
      status: "failed",
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase
      .from("transactions")
      .update(updates)
      .eq("id", transactionRecordId);

    if (error) {
      console.error("Failed to update failed record:", error);
      return false;
    }

    console.log(`✅ Successfully updated failed record ${transactionRecordId}`);
    console.log(`   New failure_reason: ${finalReason}`);
    return true;
  } catch (error) {
    console.error("Error updating failed record:", error);
    return false;
  }
}*/

// Process fee income for admin (called by transfer route)
async function processFeeIncome(
  transaction,
  feeAmount,
  fromAccount,
  toAccount,
) {
  try {
    if (feeAmount <= 0) return;

    // Record fee as revenue
    const { error: feeError } = await supabase.from("transactions").insert({
      transaction_id: `FEE${Date.now()}${Math.floor(Math.random() * 1000)}`,
      from_account_id: fromAccount.id,
      to_account_id: null,
      from_user_id: fromAccount.user_id,
      to_user_id: null,
      amount: feeAmount,
      description: `Transfer fee for transaction ${transaction.transaction_id}`,
      transaction_type: "fee",
      status: "completed",
      completed_at: new Date().toISOString(),
      is_admin_adjusted: true,
      admin_note: "Auto-generated transfer fee",
    });

    if (feeError) {
      console.error("Fee transaction error:", feeError);
    }

    // Update fee income in ledger
    await supabase.from("general_ledger").insert({
      transaction_id: transaction.id,
      account_code: "4020", // Transfer Fees account
      account_name: "Transfer Fees",
      debit_amount: 0,
      credit_amount: feeAmount,
      description: `Transfer fee for transaction ${transaction.transaction_id}`,
      reference: transaction.transaction_id,
      entry_date: new Date().toISOString(),
      posted_by: null,
      posted_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Fee processing error:", error);
  }
}

// Get recipient name by account number (for transfer confirmation)
app.get("/api/accounts/recipient", authenticate, async (req, res) => {
  const { account_number } = req.query;

  if (
    !account_number ||
    typeof account_number !== "string" ||
    account_number.length < 8
  ) {
    return res.status(400).json({ error: "Invalid account number format" });
  }

  try {
    const { data, error } = await supabase
      .from("accounts")
      .select(
        `
        id,
        account_number,
        user_id,
        users!inner (
          first_name,
          last_name
        )
      `,
      )
      .eq("account_number", account_number)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: "Account not found" });
    }

    const fullName = `${data.users.first_name} ${data.users.last_name}`;

    res.json({
      success: true,
      name: fullName.trim(),
      account_id: data.id, // optional — useful later
      user_id: data.user_id,
    });
  } catch (err) {
    console.error("Recipient lookup error:", err);
    res.status(500).json({ error: "Failed to verify account" });
  }
});

// Get available fintech providers
app.get("/api/external/providers", authenticate, async (req, res) => {
  try {
    const providers = [
      {
        id: "paypal",
        name: "PayPal",
        logo: "https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/paypal.svg",
        color: "#003087",
        fields: [
          {
            name: "recipient_email",
            label: "PayPal Email",
            type: "email",
            required: true,
          },
          {
            name: "recipient_name",
            label: "Full Name",
            type: "text",
            required: true,
          },
        ],
      },
      {
        id: "stripe",
        name: "Stripe",
        logo: "https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/stripe.svg",
        color: "#635bff",
        fields: [
          {
            name: "recipient_email",
            label: "Stripe Account Email",
            type: "email",
            required: true,
          },
          {
            name: "recipient_name",
            label: "Business/Individual Name",
            type: "text",
            required: true,
          },
        ],
      },
      {
        id: "flutterwave",
        name: "Flutterwave",
        logo: "https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/flutterwave.svg",
        color: "#f9a825",
        fields: [
          {
            name: "recipient_account",
            label: "Account Number",
            type: "text",
            required: true,
          },
          {
            name: "recipient_name",
            label: "Account Holder Name",
            type: "text",
            required: true,
          },
          {
            name: "recipient_email",
            label: "Email (Optional)",
            type: "email",
            required: false,
          },
        ],
      },
      {
        id: "paystack",
        name: "Paystack",
        logo: "https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/paystack.svg",
        color: "#25c3f0",
        fields: [
          {
            name: "recipient_account",
            label: "Account Number",
            type: "text",
            required: true,
          },
          {
            name: "recipient_name",
            label: "Account Holder Name",
            type: "text",
            required: true,
          },
          {
            name: "recipient_phone",
            label: "Phone Number",
            type: "tel",
            required: true,
          },
        ],
      },
      {
        id: "wise",
        name: "Wise (TransferWise)",
        logo: "https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/wise.svg",
        color: "#00b9b9",
        fields: [
          {
            name: "recipient_email",
            label: "Wise Email",
            type: "email",
            required: true,
          },
          {
            name: "recipient_name",
            label: "Recipient Name",
            type: "text",
            required: true,
          },
          {
            name: "recipient_account",
            label: "Account Number (if applicable)",
            type: "text",
            required: false,
          },
        ],
      },
      {
        id: "remitly",
        name: "Remitly",
        logo: "https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/remitly.svg",
        color: "#00b9b9",
        fields: [
          {
            name: "recipient_name",
            label: "Recipient Name",
            type: "text",
            required: true,
          },
          {
            name: "recipient_phone",
            label: "Phone Number",
            type: "tel",
            required: true,
          },
          {
            name: "recipient_country",
            label: "Recipient Country",
            type: "text",
            required: true,
          },
        ],
      },
      {
        id: "worldremit",
        name: "WorldRemit",
        logo: "https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/worldremit.svg",
        color: "#00b9b9",
        fields: [
          {
            name: "recipient_name",
            label: "Recipient Name",
            type: "text",
            required: true,
          },
          {
            name: "recipient_phone",
            label: "Phone Number",
            type: "tel",
            required: true,
          },
        ],
      },
      {
        id: "bank_transfer",
        name: "Bank Transfer",
        logo: "https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/bank.svg",
        color: "#4f46e5",
        fields: [
          {
            name: "bank_name",
            label: "Bank Name",
            type: "text",
            required: true,
          },
          {
            name: "recipient_account",
            label: "Account Number",
            type: "text",
            required: true,
          },
          {
            name: "recipient_name",
            label: "Account Holder Name",
            type: "text",
            required: true,
          },
          {
            name: "routing_number",
            label: "Routing Number",
            type: "text",
            required: true,
          },
          {
            name: "swift_code",
            label: "SWIFT/BIC Code",
            type: "text",
            required: false,
          },
        ],
      },
    ];

    res.json(providers);
  } catch (error) {
    console.error("Error fetching providers:", error);
    res.status(500).json({ error: "Failed to fetch providers" });
  }
});

// Create external transfer request
app.post(
  "/api/user/external-transfer",
  authenticate,
  checkAccountFrozen,
  async (req, res) => {
    console.log("=== External Transfer Request Received ===");
    console.log("User ID:", req.user?.id);
    console.log("Request body:", req.body);

    try {
      const {
        from_account_id,
        provider_id,
        recipient_name,
        recipient_account,
        recipient_email,
        recipient_phone,
        amount,
        description,
        bank_name,
      } = req.body;

      console.log("Parsed data:", {
        from_account_id,
        provider_id,
        amount,
        bank_name,
      });

      // Validate amount
      if (!amount || amount <= 0) {
        console.log("Invalid amount:", amount);
        return res.status(400).json({ error: "Invalid amount" });
      }

      if (amount < 10000) {
        return res
          .status(400)
          .json({ error: "Minimum external transfer amount is ₦10,000" });
      }

      if (amount > 15000000) {
        return res
          .status(400)
          .json({ error: "Maximum external transfer amount is ₦15,000,000" });
      }

      // Get source account
      console.log("Fetching source account:", from_account_id);
      const { data: fromAccount, error: accountError } = await supabase
        .from("accounts")
        .select("*")
        .eq("id", from_account_id)
        .eq("user_id", req.user.id)
        .single();

      if (accountError) {
        console.error("Account fetch error:", accountError);
        return res.status(404).json({
          error: "Source account not found",
          details: accountError.message,
        });
      }

      if (!fromAccount) {
        console.log("No account found for ID:", from_account_id);
        return res.status(404).json({ error: "Source account not found" });
      }

      console.log(
        "Source account found:",
        fromAccount.account_number,
        "Balance:",
        fromAccount.available_balance,
      );

      // Check sufficient funds
      if (fromAccount.available_balance < amount) {
        return res.status(400).json({ error: "Insufficient funds" });
      }

      // Get provider name
      let providerName = bank_name;
      if (provider_id) {
        const providers = {
          paypal: "PayPal",
          stripe: "Stripe",
          flutterwave: "Flutterwave",
          paystack: "Paystack",
          wise: "Wise",
          remitly: "Remitly",
          worldremit: "WorldRemit",
          bank_transfer: "Bank Transfer",
        };
        providerName = providers[provider_id] || bank_name || provider_id;
      }

      // Create external transfer record
      const transferData = {
        user_id: req.user.id,
        from_account_id: fromAccount.id,
        bank_name: providerName,
        recipient_name: recipient_name,
        recipient_account: recipient_account || null,
        recipient_email: recipient_email || null,
        recipient_phone: recipient_phone || null,
        amount: amount,
        description: description || `External transfer to ${providerName}`,
        status: "pending",
        created_at: new Date().toISOString(),
      };

      console.log("Inserting transfer record:", transferData);

      const { data: transfer, error: insertError } = await supabase
        .from("external_transfers")
        .insert(transferData)
        .select()
        .single();

      if (insertError) {
        console.error("Insert error:", insertError);
        return res.status(500).json({
          error: "Failed to create transfer record",
          details: insertError.message,
        });
      }

      console.log("Transfer record created:", transfer.id);

      // Immediately deduct amount from user balance
      const { error: updateError } = await supabase
        .from("accounts")
        .update({
          balance: fromAccount.balance - amount,
          available_balance: fromAccount.available_balance - amount,
          updated_at: new Date().toISOString(),
        })
        .eq("id", fromAccount.id);

      if (updateError) {
        console.error("Balance update error:", updateError);
        // Rollback would be ideal here, but for now log it
      }

      // Create transaction record for the deduction
      const { error: transError } = await supabase.from("transactions").insert({
        from_account_id: fromAccount.id,
        from_user_id: req.user.id,
        amount: amount,
        description: `External transfer to ${providerName} - ${recipient_name} (Pending approval)`,
        transaction_type: "external_transfer",
        status: "completed",
        completed_at: new Date().toISOString(),
        is_admin_adjusted: false,
      });

      if (transError) {
        console.error("Transaction creation error:", transError);
      }

      // Create notification for user
      await supabase.from("notifications").insert({
        user_id: req.user.id,
        title: "External Transfer Initiated",
        message: `Your transfer of $${amount} to ${providerName} has been initiated. Funds have been deducted from your account and will be processed within 2-3 business days after approval.`,
        type: "info",
        created_at: new Date().toISOString(),
      });

      console.log("External transfer completed successfully");
      res.json({
        success: true,
        message:
          "External transfer initiated successfully. Funds will be processed within 2-3 business days.",
        transfer: transfer,
        estimated_completion: "2-3 business days",
      });
    } catch (error) {
      console.error("External transfer error - FULL DETAILS:", error);
      console.error("Error stack:", error.stack);
      res.status(500).json({
        error: "Failed to process external transfer",
        details: error.message,
        stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
      });
    }
  },
);

// Get user's external transfer history
app.get("/api/user/external-transfers", authenticate, async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const offset = (page - 1) * limit;

    let query = supabase
      .from("external_transfers")
      .select("*", { count: "exact" })
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false });

    if (status && status !== "all") {
      query = query.eq("status", status);
    }

    const {
      data: transfers,
      error,
      count,
    } = await query.range(offset, offset + limit - 1);

    if (error) throw error;

    res.json({
      transfers: transfers || [],
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count || 0,
        pages: Math.ceil((count || 0) / limit),
      },
    });
  } catch (error) {
    console.error("Error fetching external transfers:", error);
    res.status(500).json({ error: "Failed to fetch external transfers" });
  }
});

// Verify OTP and complete transaction
app.post("/api/user/verify-otp", authenticate, async (req, res) => {
  try {
    const { transaction_id, otp_code } = req.body;

    // Get OTP record
    const { data: otpRecord } = await supabase
      .from("otps")
      .select("*")
      .eq("transaction_id", transaction_id)
      .eq("otp_code", otp_code)
      .eq("is_used", false)
      .single();

    if (!otpRecord || new Date(otpRecord.expires_at) < new Date()) {
      return res.status(401).json({ error: "Invalid or expired OTP" });
    }

    // Mark OTP as used
    await supabase
      .from("otps")
      .update({ is_used: true })
      .eq("id", otpRecord.id);

    // Get transaction
    const { data: transaction } = await supabase
      .from("transactions")
      .select("*")
      .eq("id", transaction_id)
      .single();

    // Get accounts
    const { data: fromAccount } = await supabase
      .from("accounts")
      .select("*")
      .eq("id", transaction.from_account_id)
      .single();

    const { data: toAccount } = await supabase
      .from("accounts")
      .select("*")
      .eq("id", transaction.to_account_id)
      .single();

    // Update balances
    await supabase
      .from("accounts")
      .update({
        balance: fromAccount.balance - transaction.amount,
        available_balance: fromAccount.available_balance - transaction.amount,
      })
      .eq("id", transaction.from_account_id);

    await supabase
      .from("accounts")
      .update({
        balance: toAccount.balance + transaction.amount,
        available_balance: toAccount.available_balance + transaction.amount,
      })
      .eq("id", transaction.to_account_id);

    // Update transaction status
    await supabase
      .from("transactions")
      .update({
        status: "completed",
        completed_at: new Date(),
        otp_verified: true,
      })
      .eq("id", transaction_id);

    res.json({ message: "Transaction completed successfully" });
  } catch (error) {
    console.error("OTP verification error:", error);
    res.status(500).json({ error: "OTP verification failed" });
  }
});

// Get cards
app.get(
  "/api/user/cards",
  authenticate,
  checkAccountFrozen,
  async (req, res) => {
    try {
      const { data: cards, error } = await supabase
        .from("cards")
        .select("*, account:accounts(account_number)")
        .eq("user_id", req.user.id);

      if (error) throw error;

      res.json(cards);
    } catch (error) {
      console.error("Cards fetch error:", error);
      res.status(500).json({ error: "Failed to fetch cards" });
    }
  },
);

// Purchase card
app.post(
  "/api/user/purchase-card",
  authenticate,
  checkAccountFrozen,
  async (req, res) => {
    try {
      const { card_type, is_virtual = false, purchase_method } = req.body;

      // Get card purchase settings
      const { data: settings } = await supabase
        .from("admin_settings")
        .select("setting_value")
        .eq("setting_key", "card_purchase_method")
        .single();

      const cardPrice = 3000; // Card price

      // Generate card details
      const cardNumber =
        "4" +
        Math.floor(Math.random() * 1000000000000000)
          .toString()
          .padStart(15, "0");
      const expiryDate = new Date();
      expiryDate.setFullYear(expiryDate.getFullYear() + 3);
      const cvv = Math.floor(100 + Math.random() * 900).toString();

      const { data: card, error } = await supabase
        .from("cards")
        .insert({
          user_id: req.user.id,
          account_id: null, // Will be linked after activation
          card_number: cardNumber,
          card_type,
          expiry_date: expiryDate,
          cvv,
          card_status: "inactive",
          is_virtual,
          purchase_method: purchase_method || settings?.setting_value,
          purchase_reference: uuidv4(),
        })
        .select()
        .single();

      if (error) throw error;

      res.json({
        message: "Card purchased successfully",
        card,
        payment_instructions: {
          method: purchase_method || settings?.setting_value,
          amount: cardPrice,
          reference: card.purchase_reference,
          // Add crypto payment details if applicable
          crypto_address:
            purchase_method === "crypto"
              ? "0x742d35Cc6634C0532925a3b844Bc1e7f9c5f5f5f"
              : null,
        },
      });
    } catch (error) {
      console.error("Card purchase error:", error);
      res.status(500).json({ error: "Failed to purchase card" });
    }
  },
);

// Activate card
app.post(
  "/api/user/activate-card/:cardId",
  authenticate,
  checkAccountFrozen,
  async (req, res) => {
    try {
      const { cardId } = req.params;

      // Check if card is purchased and belongs to user
      const { data: card } = await supabase
        .from("cards")
        .select("*")
        .eq("id", cardId)
        .eq("user_id", req.user.id)
        .single();

      if (!card) {
        return res.status(404).json({ error: "Card not found" });
      }

      if (card.card_status !== "inactive") {
        return res.status(400).json({ error: "Card cannot be activated" });
      }

      // Get user's primary account
      const { data: account } = await supabase
        .from("accounts")
        .select("id")
        .eq("user_id", req.user.id)
        .eq("account_type", "checking")
        .single();

      // Activate card
      await supabase
        .from("cards")
        .update({
          card_status: "active",
          account_id: account.id,
        })
        .eq("id", cardId);

      res.json({ message: "Card activated successfully" });
    } catch (error) {
      console.error("Card activation error:", error);
      res.status(500).json({ error: "Failed to activate card" });
    }
  },
);

// Toggle card status (freeze/unfreeze)
app.post(
  "/api/user/toggle-card/:cardId",
  authenticate,
  checkAccountFrozen,
  async (req, res) => {
    try {
      const { cardId } = req.params;
      const { action } = req.body; // 'freeze' or 'unfreeze'

      const newStatus = action === "freeze" ? "frozen" : "active";

      const { error } = await supabase
        .from("cards")
        .update({ card_status: newStatus })
        .eq("id", cardId)
        .eq("user_id", req.user.id);

      if (error) throw error;

      res.json({ message: `Card ${action}d successfully` });
    } catch (error) {
      console.error("Card toggle error:", error);
      res.status(500).json({ error: "Failed to update card status" });
    }
  },
);

// Report lost/stolen card
app.post(
  "/api/user/report-card/:cardId",
  authenticate,
  checkAccountFrozen,
  async (req, res) => {
    try {
      const { cardId } = req.params;

      await supabase
        .from("cards")
        .update({ card_status: "lost" })
        .eq("id", cardId)
        .eq("user_id", req.user.id);

      // Create support ticket
      const { data: ticket } = await supabase
        .from("support_tickets")
        .insert({
          user_id: req.user.id,
          subject: "Lost/Stolen Card Report",
          message: `Card ID: ${cardId} reported as lost/stolen`,
          priority: "high",
        })
        .select()
        .single();

      res.json({
        message: "Card reported successfully. Support ticket created.",
        ticket,
      });
    } catch (error) {
      console.error("Card report error:", error);
      res.status(500).json({ error: "Failed to report card" });
    }
  },
);
//===================New beneficiafries rout =========================

// Get user's recent beneficiaries (for the transfer page)
app.get("/api/user/beneficiaries/recent", authenticate, async (req, res) => {
  try {
    const beneficiaries = await getRecentBeneficiaries(req.user.id);
    res.json({ beneficiaries });
  } catch (error) {
    console.error("Error fetching beneficiaries:", error);
    res.status(500).json({ error: "Failed to fetch beneficiaries" });
  }
});

// =========================Bills Sections =========================
// Get bills
app.get(
  "/api/user/bills",
  authenticate,
  checkAccountFrozen,
  async (req, res) => {
    try {
      const { data: bills, error } = await supabase
        .from("bills")
        .select("*")
        .eq("user_id", req.user.id);

      if (error) throw error;

      res.json(bills);
    } catch (error) {
      console.error("Bills fetch error:", error);
      res.status(500).json({ error: "Failed to fetch bills" });
    }
  },
);

// Add bill
app.post(
  "/api/user/bills",
  authenticate,
  checkAccountFrozen,
  async (req, res) => {
    try {
      const {
        biller_name,
        biller_account,
        category,
        amount,
        due_date,
        is_recurring,
        recurring_frequency,
      } = req.body;

      const { data: bill, error } = await supabase
        .from("bills")
        .insert({
          user_id: req.user.id,
          biller_name,
          biller_account,
          category,
          amount,
          due_date,
          is_recurring,
          recurring_frequency,
        })
        .select()
        .single();

      if (error) throw error;

      res.json({ message: "Bill added successfully", bill });
    } catch (error) {
      console.error("Add bill error:", error);
      res.status(500).json({ error: "Failed to add bill" });
    }
  },
);

// Pay bill
app.post(
  "/api/user/pay-bill/:billId",
  authenticate,
  checkAccountFrozen,
  async (req, res) => {
    try {
      const { billId } = req.params;
      const { account_id } = req.body;

      // Get bill
      const { data: bill } = await supabase
        .from("bills")
        .select("*")
        .eq("id", billId)
        .eq("user_id", req.user.id)
        .single();

      if (!bill) {
        return res.status(404).json({ error: "Bill not found" });
      }

      // Get account
      const { data: account } = await supabase
        .from("accounts")
        .select("*")
        .eq("id", account_id)
        .eq("user_id", req.user.id)
        .single();

      if (!account) {
        return res.status(404).json({ error: "Account not found" });
      }

      if (account.available_balance < bill.amount) {
        return res.status(400).json({ error: "Insufficient funds" });
      }

      // Create transaction
      const { data: transaction } = await supabase
        .from("transactions")
        .insert({
          from_account_id: account_id,
          from_user_id: req.user.id,
          amount: bill.amount,
          description: `Bill payment to ${bill.biller_name}`,
          transaction_type: "bill_payment",
          status: "completed",
          completed_at: new Date(),
        })
        .select()
        .single();

      // Update account balance
      await supabase
        .from("accounts")
        .update({
          balance: account.balance - bill.amount,
          available_balance: account.available_balance - bill.amount,
        })
        .eq("id", account_id);

      // Update bill status
      await supabase.from("bills").update({ status: "paid" }).eq("id", billId);

      // If recurring, create next bill
      if (bill.is_recurring) {
        let nextDueDate = new Date(bill.due_date);
        switch (bill.recurring_frequency) {
          case "monthly":
            nextDueDate.setMonth(nextDueDate.getMonth() + 1);
            break;
          case "quarterly":
            nextDueDate.setMonth(nextDueDate.getMonth() + 3);
            break;
          case "yearly":
            nextDueDate.setFullYear(nextDueDate.getFullYear() + 1);
            break;
        }

        await supabase.from("bills").insert({
          user_id: req.user.id,
          biller_name: bill.biller_name,
          biller_account: bill.biller_account,
          category: bill.category,
          amount: bill.amount,
          due_date: nextDueDate,
          is_recurring: true,
          recurring_frequency: bill.recurring_frequency,
          status: "pending",
        });
      }

      res.json({ message: "Bill paid successfully", transaction });
    } catch (error) {
      console.error("Pay bill error:", error);
      res.status(500).json({ error: "Failed to pay bill" });
    }
  },
);

// Get exchange rates
app.get("/api/user/exchange-rates", authenticate, async (req, res) => {
  try {
    const { data: rates, error } = await supabase
      .from("exchange_rates")
      .select("*");

    if (error) throw error;

    res.json(rates);
  } catch (error) {
    console.error("Exchange rates fetch error:", error);
    res.status(500).json({ error: "Failed to fetch exchange rates" });
  }
});

// Currency conversion
app.post(
  "/api/user/convert-currency",
  authenticate,
  checkAccountFrozen,
  async (req, res) => {
    try {
      const { from_currency, to_currency, amount } = req.body;

      const { data: rate } = await supabase
        .from("exchange_rates")
        .select("rate")
        .eq("from_currency", from_currency)
        .eq("to_currency", to_currency)
        .single();

      if (!rate) {
        return res.status(404).json({ error: "Exchange rate not found" });
      }

      const convertedAmount = amount * rate.rate;

      res.json({
        from_currency,
        to_currency,
        amount,
        converted_amount: convertedAmount,
        rate: rate.rate,
      });
    } catch (error) {
      console.error("Currency conversion error:", error);
      res.status(500).json({ error: "Conversion failed" });
    }
  },
);

// Get budgets
app.get(
  "/api/user/budgets",
  authenticate,
  checkAccountFrozen,
  async (req, res) => {
    try {
      const { month, year } = req.query;
      const currentDate = new Date();
      const queryMonth = month || currentDate.getMonth() + 1;
      const queryYear = year || currentDate.getFullYear();

      const { data: budgets, error } = await supabase
        .from("budgets")
        .select("*")
        .eq("user_id", req.user.id)
        .eq("month", queryMonth)
        .eq("year", queryYear);

      if (error) throw error;

      res.json(budgets);
    } catch (error) {
      console.error("Budgets fetch error:", error);
      res.status(500).json({ error: "Failed to fetch budgets" });
    }
  },
);

// Create or update budget
app.post(
  "/api/user/budgets",
  authenticate,
  checkAccountFrozen,
  async (req, res) => {
    try {
      const { category, amount, month, year } = req.body;

      // Check if budget exists
      const { data: existingBudget } = await supabase
        .from("budgets")
        .select("id")
        .eq("user_id", req.user.id)
        .eq("category", category)
        .eq("month", month)
        .eq("year", year)
        .single();

      if (existingBudget) {
        // Update
        await supabase
          .from("budgets")
          .update({ amount })
          .eq("id", existingBudget.id);
      } else {
        // Create
        await supabase.from("budgets").insert({
          user_id: req.user.id,
          category,
          amount,
          month,
          year,
          spent: 0,
        });
      }

      res.json({ message: "Budget saved successfully" });
    } catch (error) {
      console.error("Budget save error:", error);
      res.status(500).json({ error: "Failed to save budget" });
    }
  },
);

// Get support tickets
app.get("/api/user/tickets", authenticate, async (req, res) => {
  try {
    const { data: tickets, error } = await supabase
      .from("support_tickets")
      .select("*")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false });

    if (error) throw error;

    res.json(tickets);
  } catch (error) {
    console.error("Tickets fetch error:", error);
    res.status(500).json({ error: "Failed to fetch tickets" });
  }
});

// Create support ticket
app.post("/api/user/tickets", authenticate, async (req, res) => {
  try {
    const { subject, message, priority = "medium" } = req.body;

    const { data: ticket, error } = await supabase
      .from("support_tickets")
      .insert({
        user_id: req.user.id,
        subject,
        message,
        priority,
      })
      .select()
      .single();

    if (error) throw error;

    res.json({ message: "Ticket created successfully", ticket });
  } catch (error) {
    console.error("Ticket creation error:", error);
    res.status(500).json({ error: "Failed to create ticket" });
  }
});

// Get chat messages for ticket
app.get(
  "/api/user/tickets/:ticketId/messages",
  authenticate,
  async (req, res) => {
    try {
      const { ticketId } = req.params;

      // Verify ticket belongs to user
      const { data: ticket } = await supabase
        .from("support_tickets")
        .select("id")
        .eq("id", ticketId)
        .eq("user_id", req.user.id)
        .single();

      if (!ticket) {
        return res.status(404).json({ error: "Ticket not found" });
      }

      const { data: messages, error } = await supabase
        .from("chat_messages")
        .select("*, sender:sender_id(first_name, last_name, role)")
        .eq("ticket_id", ticketId)
        .order("created_at", { ascending: true });

      if (error) throw error;

      res.json(messages);
    } catch (error) {
      console.error("Messages fetch error:", error);
      res.status(500).json({ error: "Failed to fetch messages" });
    }
  },
);

// Send chat message
app.post(
  "/api/user/tickets/:ticketId/messages",
  authenticate,
  async (req, res) => {
    try {
      const { ticketId } = req.params;
      const { message } = req.body;

      // Verify ticket belongs to user
      const { data: ticket } = await supabase
        .from("support_tickets")
        .select("id")
        .eq("id", ticketId)
        .eq("user_id", req.user.id)
        .single();

      if (!ticket) {
        return res.status(404).json({ error: "Ticket not found" });
      }

      const { data: chatMessage, error } = await supabase
        .from("chat_messages")
        .insert({
          ticket_id: ticketId,
          sender_id: req.user.id,
          message,
          is_admin_reply: false,
        })
        .select()
        .single();

      if (error) throw error;

      res.json({ message: "Message sent successfully", chatMessage });
    } catch (error) {
      console.error("Message send error:", error);
      res.status(500).json({ error: "Failed to send message" });
    }
  },
);

// ==================== IMPROVED NOTIFICATION ROUTES ====================

// Get notifications with pagination and unread count
app.get("/api/user/notifications", authenticate, async (req, res) => {
  try {
    const { page = 1, limit = 20, unread_only = false } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    // First, check if the table exists and has the right structure
    const { error: tableCheckError } = await supabase
      .from("notifications")
      .select("id")
      .limit(1);

    if (tableCheckError && tableCheckError.code === "42P01") {
      // Table doesn't exist, create it
      console.log("Notifications table doesn't exist, creating...");
      await createNotificationsTable();
    }

    let query = supabase
      .from("notifications")
      .select("*", { count: "exact" })
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false });

    if (unread_only === "true") {
      query = query.eq("is_read", false);
    }

    const {
      data: notifications,
      error,
      count,
    } = await query.range(offset, offset + parseInt(limit) - 1);

    if (error) {
      console.error("Supabase notifications error:", error);
      // Return empty array instead of error
      return res.json({
        notifications: [],
        unread_count: 0,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: 0,
          pages: 0,
        },
      });
    }

    // Get unread count for badge
    const { count: unreadCount, error: unreadError } = await supabase
      .from("notifications")
      .select("*", { count: "exact", head: true })
      .eq("user_id", req.user.id)
      .eq("is_read", false);

    if (unreadError) {
      console.error("Unread count error:", unreadError);
    }

    res.json({
      notifications: notifications || [],
      unread_count: unreadCount || 0,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count || 0,
        pages: Math.ceil((count || 0) / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error("Notifications fetch error:", error);
    // Return empty array instead of error
    res.json({
      notifications: [],
      unread_count: 0,
      pagination: {
        page: 1,
        limit: 20,
        total: 0,
        pages: 0,
      },
    });
  }
});

// Helper function to create notifications table if it doesn't exist
async function createNotificationsTable() {
  try {
    // Check if table exists
    const { error: checkError } = await supabase
      .from("notifications")
      .select("id")
      .limit(1);

    if (checkError && checkError.code === "42P01") {
      // Create the notifications table using raw SQL
      const createTableSQL = `
                CREATE TABLE IF NOT EXISTS notifications (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
                    title VARCHAR(200) NOT NULL,
                    message TEXT NOT NULL,
                    type VARCHAR(50) DEFAULT 'info',
                    is_read BOOLEAN DEFAULT false,
                    read_at TIMESTAMP,
                    action_url TEXT,
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW()
                );
                
                CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
                CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON notifications(is_read);
                CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at);
            `;

      // Execute through Supabase's RPC if you have the function, or log to run manually
      console.log("Please run this SQL in your Supabase SQL editor:");
      console.log(createTableSQL);

      // Alternative: Try to insert a test record to see if table exists
      // If it fails, log the SQL for manual execution
    }
  } catch (error) {
    console.error("Error checking/creating notifications table:", error);
  }
}

// Mark single notification as read
app.post("/api/user/notifications/:id/read", authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    console.log(`Marking notification ${id} as read for user ${req.user.id}`);

    // Check if notification exists and belongs to user
    const { data: existing, error: checkError } = await supabase
      .from("notifications")
      .select("id, is_read")
      .eq("id", id)
      .eq("user_id", req.user.id)
      .single();

    if (checkError) {
      console.error("Notification not found:", checkError);
      return res.status(404).json({ error: "Notification not found" });
    }

    if (existing.is_read) {
      return res.json({ success: true, message: "Already read" });
    }

    const { error } = await supabase
      .from("notifications")
      .update({
        is_read: true,
        read_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("user_id", req.user.id);

    if (error) {
      console.error("Update error:", error);
      throw error;
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Notification update error:", error);
    res.status(500).json({ error: "Failed to update notification" });
  }
});

// Mark all notifications as read
app.post(
  "/api/user/notifications/mark-all-read",
  authenticate,
  async (req, res) => {
    try {
      const { error } = await supabase
        .from("notifications")
        .update({
          is_read: true,
          read_at: new Date().toISOString(),
        })
        .eq("user_id", req.user.id)
        .eq("is_read", false);

      if (error) {
        console.error("Mark all update error:", error);
        throw error;
      }

      res.json({ success: true });
    } catch (error) {
      console.error("Mark all read error:", error);
      res.status(500).json({ error: "Failed to mark all as read" });
    }
  },
);

// Delete notification
app.delete("/api/user/notifications/:id", authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from("notifications")
      .delete()
      .eq("id", id)
      .eq("user_id", req.user.id);

    if (error) throw error;

    res.json({ success: true });
  } catch (error) {
    console.error("Notification delete error:", error);
    res.status(500).json({ error: "Failed to delete notification" });
  }
});

// Register push token - FIXED VERSION
app.post("/api/user/register-push-token", authenticate, async (req, res) => {
  try {
    const { push_token, platform, device_name } = req.body;

    console.log("=== REGISTER PUSH TOKEN ===");
    console.log("User ID:", req.user.id);
    console.log("Platform:", platform);
    console.log("Token length:", push_token?.length);

    if (!push_token) {
      return res.status(400).json({ error: "Push token is required" });
    }

    // First, check if token already exists and reactivate it
    const { data: existingToken } = await supabase
      .from("user_push_tokens")
      .select("id")
      .eq("user_id", req.user.id)
      .eq("push_token", push_token)
      .maybeSingle();

    if (existingToken) {
      // Reactivate existing token
      const { error: updateError } = await supabase
        .from("user_push_tokens")
        .update({
          is_active: true,
          last_active: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", existingToken.id);

      if (updateError) {
        console.error("Update error:", updateError);
      }
    } else {
      // Insert new token
      const { error: insertError } = await supabase
        .from("user_push_tokens")
        .insert({
          user_id: req.user.id,
          push_token: push_token,
          platform: platform || "android",
          device_name: device_name || null,
          is_active: true,
          last_active: new Date().toISOString(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });

      if (insertError) {
        console.error("Insert error:", insertError);
        // Check if it's a duplicate key error
        if (insertError.code === "23505") {
          // Duplicate - try to reactivate instead
          const { error: reactivateError } = await supabase
            .from("user_push_tokens")
            .update({
              is_active: true,
              last_active: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("user_id", req.user.id)
            .eq("push_token", push_token);

          if (reactivateError) {
            console.error("Reactivate error:", reactivateError);
          }
        } else {
          return res.status(500).json({
            error: "Failed to register push token: " + insertError.message,
          });
        }
      }
    }

    // Also ensure push settings exist
    const { data: existingSettings } = await supabase
      .from("user_push_settings")
      .select("id")
      .eq("user_id", req.user.id)
      .maybeSingle();

    if (!existingSettings) {
      await supabase.from("user_push_settings").insert({
        user_id: req.user.id,
        notifications_enabled: true,
        transfers: true,
        savings: true,
        security: true,
        promotions: false,
        bills: true,
        updated_at: new Date().toISOString(),
      });
    } else {
      // Update notifications_enabled to true since they're registering
      await supabase
        .from("user_push_settings")
        .update({
          notifications_enabled: true,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", req.user.id);
    }

    console.log("Push token registered successfully for user:", req.user.id);
    res.json({
      success: true,
      message: "Push token registered successfully",
    });
  } catch (error) {
    console.error("Push token registration error:", error);
    res
      .status(500)
      .json({ error: "Failed to register push token: " + error.message });
  }
});

// Delete push token (when user logs out)
app.delete("/api/user/push-token", authenticate, async (req, res) => {
  try {
    const { push_token } = req.body;

    if (push_token) {
      await supabase
        .from("user_push_tokens")
        .update({ is_active: false })
        .eq("user_id", req.user.id)
        .eq("push_token", push_token);
    } else {
      // Deactivate all tokens for this user
      await supabase
        .from("user_push_tokens")
        .update({ is_active: false })
        .eq("user_id", req.user.id);
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Push token deletion error:", error);
    res.status(500).json({ error: "Failed to delete push token" });
  }
});

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
        { url: "/dashboard.html", type: "test" },
      );
      results.push({ sent });
    }

    res.json({
      success: true,
      message: `Test notification sent to ${results.length} device(s)`,
      results,
    });
  } catch (error) {
    console.error("Test push error:", error);
    res.status(500).json({ error: "Failed to send test notification" });
  }
});

// Get push notification settings (FIXED)
app.get("/api/user/push-settings", authenticate, async (req, res) => {
  try {
    console.log("Fetching push settings for user:", req.user.id);

    // Try to get existing settings
    const { data: settings, error } = await supabase
      .from("user_push_settings")
      .select("*")
      .eq("user_id", req.user.id)
      .maybeSingle();

    if (error) {
      console.error("Fetch error:", error);
      // Return default settings
      return res.json({
        notifications_enabled: false,
        transfers: true,
        savings: true,
        security: true,
        promotions: false,
        bills: true,
      });
    }

    // If settings exist, return them
    if (settings) {
      return res.json(settings);
    }

    // No settings found, create default and return
    console.log("No settings found, creating defaults");
    const defaultSettings = {
      user_id: req.user.id,
      notifications_enabled: false,
      transfers: true,
      savings: true,
      security: true,
      promotions: false,
      bills: true,
    };

    const { data: newSettings, error: insertError } = await supabase
      .from("user_push_settings")
      .insert(defaultSettings)
      .select()
      .single();

    if (insertError) {
      console.error("Insert error:", insertError);
      // Return defaults anyway
      return res.json({
        notifications_enabled: false,
        transfers: true,
        savings: true,
        security: true,
        promotions: false,
        bills: true,
      });
    }

    res.json(newSettings);
  } catch (error) {
    console.error("Push settings fetch error:", error);
    // Always return default settings to avoid breaking the UI
    res.json({
      notifications_enabled: false,
      transfers: true,
      savings: true,
      security: true,
      promotions: false,
      bills: true,
    });
  }
});

// Update push notification settings (FIXED - handles duplicate key properly)
app.post("/api/user/push-settings", authenticate, async (req, res) => {
  try {
    console.log("Updating push settings for user:", req.user.id);
    console.log("Request body:", req.body);

    const {
      transfers,
      savings,
      promotions,
      security,
      bills,
      notifications_enabled,
    } = req.body;

    // Prepare update data
    const updateData = {
      updated_at: new Date().toISOString(),
    };

    if (transfers !== undefined) updateData.transfers = transfers;
    if (savings !== undefined) updateData.savings = savings;
    if (promotions !== undefined) updateData.promotions = promotions;
    if (security !== undefined) updateData.security = security;
    if (bills !== undefined) updateData.bills = bills;
    if (notifications_enabled !== undefined)
      updateData.notifications_enabled = notifications_enabled;

    // CRITICAL FIX: Use upsert with onConflict to handle duplicate key properly
    const { data, error } = await supabase
      .from("user_push_settings")
      .upsert(
        {
          user_id: req.user.id,
          ...updateData,
        },
        {
          onConflict: "user_id", // This tells Supabase to update if user_id exists
          ignoreDuplicates: false, // Don't ignore, update instead
        },
      )
      .select()
      .single();

    if (error) {
      console.error("Upsert error:", error);

      // Fallback: Try update first, then insert
      const { data: updateData_result, error: updateError } = await supabase
        .from("user_push_settings")
        .update(updateData)
        .eq("user_id", req.user.id)
        .select()
        .single();

      if (updateError || !updateData_result) {
        // If update fails, try insert
        const { data: insertData, error: insertError } = await supabase
          .from("user_push_settings")
          .insert({
            user_id: req.user.id,
            ...updateData,
          })
          .select()
          .single();

        if (insertError) {
          console.error("Insert fallback error:", insertError);
          return res.status(500).json({
            error: "Failed to save push settings: " + insertError.message,
          });
        }

        return res.json({ success: true, settings: insertData });
      }

      return res.json({ success: true, settings: updateData_result });
    }

    console.log("Push settings saved successfully:", data);
    res.json({ success: true, settings: data });
  } catch (error) {
    console.error("Push settings update error:", error);
    res
      .status(500)
      .json({ error: "Failed to update push settings: " + error.message });
  }
});

// Request OTP for withdrawal
app.post(
  "/api/user/request-withdrawal-otp",
  authenticate,
  checkAccountFrozen,
  async (req, res) => {
    try {
      const { amount, account_id, bank_details } = req.body;

      // Check if user is frozen
      if (req.user.is_frozen) {
        return res.status(403).json({
          error: "Account frozen. Please contact support.",
          requires_otp: true,
        });
      }

      // Check OTP mode
      const { data: settings } = await supabase
        .from("admin_settings")
        .select("setting_value")
        .eq("setting_key", "otp_mode")
        .single();

      const otpMode = settings?.setting_value === "on";

      if (!otpMode && !req.user.is_frozen) {
        return res.json({
          message: "OTP not required",
          requires_otp: false,
        });
      }

      // Create withdrawal request in chat
      const { data: ticket } = await supabase
        .from("support_tickets")
        .insert({
          user_id: req.user.id,
          subject: "OTP Request for Withdrawal",
          message: JSON.stringify({
            type: "otp_request",
            action: "withdrawal",
            amount,
            account_id,
            bank_details,
          }),
          priority: "high",
          status: "open",
        })
        .select()
        .single();

      // Send auto-reply with OTP request instructions
      await supabase.from("chat_messages").insert({
        ticket_id: ticket.id,
        sender_id: req.user.id,
        message: "I need an OTP code for withdrawal",
        is_admin_reply: false,
      });

      res.json({
        message: "OTP request sent. Please check chat for OTP code.",
        requires_otp: true,
        ticket_id: ticket.id,
      });
    } catch (error) {
      console.error("OTP request error:", error);
      res.status(500).json({ error: "Failed to request OTP" });
    }
  },
);

// Process withdrawal with OTP
app.post(
  "/api/user/process-withdrawal",
  authenticate,
  checkAccountFrozen,
  async (req, res) => {
    try {
      const { amount, account_id, otp_code, bank_details } = req.body;

      // Verify OTP
      const { data: otpRecord } = await supabase
        .from("otps")
        .select("*")
        .eq("otp_code", otp_code)
        .eq("user_id", req.user.id)
        .eq("otp_type", "withdrawal")
        .eq("is_used", false)
        .single();

      if (!otpRecord || new Date(otpRecord.expires_at) < new Date()) {
        return res.status(401).json({ error: "Invalid or expired OTP" });
      }

      // Mark OTP as used
      await supabase
        .from("otps")
        .update({ is_used: true })
        .eq("id", otpRecord.id);

      // Get account
      const { data: account } = await supabase
        .from("accounts")
        .select("*")
        .eq("id", account_id)
        .eq("user_id", req.user.id)
        .single();

      if (!account) {
        return res.status(404).json({ error: "Account not found" });
      }

      if (account.available_balance < amount) {
        return res.status(400).json({ error: "Insufficient funds" });
      }

      // Create withdrawal transaction
      const { data: transaction } = await supabase
        .from("transactions")
        .insert({
          from_account_id: account_id,
          from_user_id: req.user.id,
          amount,
          description: `Withdrawal to ${bank_details?.bank_name || "external account"}`,
          transaction_type: "withdrawal",
          status: "completed",
          completed_at: new Date(),
          otp_verified: true,
        })
        .select()
        .single();

      // Update account balance
      await supabase
        .from("accounts")
        .update({
          balance: account.balance - amount,
          available_balance: account.available_balance - amount,
        })
        .eq("id", account_id);

      res.json({
        message: "Withdrawal processed successfully",
        transaction,
      });
    } catch (error) {
      console.error("Withdrawal error:", error);
      res.status(500).json({ error: "Withdrawal failed" });
    }
  },
);

// ==================== SAVINGS ROUTES ====================

// index.js - Add this near your other savings routes

// Process spare change savings after transfer
app.post(
  "/api/user/savings/spare-change/process",
  authenticate,
  async (req, res) => {
    try {
      const { from_account_id, amount } = req.body;

      if (!amount || amount <= 0) {
        return res.json({ saved_amount: 0 }); // No spare change for invalid amounts
      }

      // Get user's spare change savings plan
      const { data: spareChange, error: spareError } = await supabase
        .from("spare_change_savings")
        .select("*")
        .eq("user_id", req.user.id)
        .eq("status", "active")
        .eq("auto_save", true)
        .maybeSingle();

      // If no active spare change plan, return early
      if (spareError || !spareChange) {
        return res.json({ saved_amount: 0 });
      }

      // Calculate spare change amount (percentage of transfer)
      const percentageRate = spareChange.percentage_rate || 3;
      const spareAmount = amount * (percentageRate / 100);

      // Don't save if amount is too small (less than 1 NGN)
      if (spareAmount < 1) {
        return res.json({ saved_amount: 0 });
      }

      // Get user's account for balance check
      const { data: account, error: accError } = await supabase
        .from("accounts")
        .select("*")
        .eq("id", from_account_id)
        .eq("user_id", req.user.id)
        .single();

      if (accError || !account) {
        console.error("Account not found for spare change");
        return res.json({ saved_amount: 0 });
      }

      // Check if sufficient balance (user already paid transfer amount, but need extra for spare change)
      if (account.available_balance < spareAmount) {
        console.log("Insufficient balance for spare change savings");
        return res.json({ saved_amount: 0 });
      }

      // Deduct spare change amount
      const newBalance = account.balance - spareAmount;
      const newAvailable = account.available_balance - spareAmount;

      const { error: updateError } = await supabase
        .from("accounts")
        .update({
          balance: newBalance,
          available_balance: newAvailable,
          updated_at: new Date(),
        })
        .eq("id", from_account_id);

      if (updateError) {
        console.error("Balance update error for spare change:", updateError);
        return res.json({ saved_amount: 0 });
      }

      // Update spare change savings
      const newCurrentSaved = (spareChange.current_saved || 0) + spareAmount;
      const newTotalSaved = (spareChange.total_saved || 0) + spareAmount;

      const { error: updateSpareError } = await supabase
        .from("spare_change_savings")
        .update({
          current_saved: newCurrentSaved,
          total_saved: newTotalSaved,
          updated_at: new Date(),
        })
        .eq("id", spareChange.id);

      if (updateSpareError) {
        console.error("Spare change update error:", updateSpareError);
      }

      // Create transaction record for spare change
      const { error: transError } = await supabase.from("transactions").insert({
        from_account_id: from_account_id,
        from_user_id: req.user.id,
        amount: spareAmount,
        description: `Spare Change: ${percentageRate}% from transfer of ₦${amount.toFixed(2)}`,
        transaction_type: "spare_change",
        status: "completed",
        completed_at: new Date(),
        created_at: new Date(),
      });

      if (transError) {
        console.error("Spare change transaction error:", transError);
      }

      // Create savings transaction record
      await supabase.from("savings_transactions").insert({
        user_id: req.user.id,
        savings_type: "spare_change",
        savings_id: spareChange.id,
        amount: spareAmount,
        transaction_type: "deposit",
        description: `Auto-saved ${percentageRate}% of transfer (₦${amount.toFixed(2)})`,
      });

      console.log(
        `Spare change saved: ₦${spareAmount.toFixed(2)} for user ${req.user.id}`,
      );

      res.json({
        success: true,
        saved_amount: spareAmount,
        percentage_rate: percentageRate,
        new_balance: newAvailable,
        message: `${percentageRate}% (₦${spareAmount.toFixed(2)}) saved to your Spare Change`,
      });
    } catch (error) {
      console.error("Spare change processing error:", error);
      // Always return success with saved_amount: 0 to not break the transfer flow
      res.json({ saved_amount: 0, error: error.message });
    }
  },
);

// Get savings summary (check if user has active plans) - SINGLE VERSION
app.get("/api/user/savings/summary", authenticate, async (req, res) => {
  try {
    console.log("Fetching savings summary for user:", req.user.id);

    const [harvest, fixed, savebox, target, spareChange] = await Promise.all([
      supabase
        .from("user_harvest_enrollments")
        .select("id, status, auto_save, total_saved")
        .eq("user_id", req.user.id)
        .eq("status", "active")
        .maybeSingle(),
      supabase
        .from("fixed_savings")
        .select("id, status, auto_save, current_saved, maturity_date")
        .eq("user_id", req.user.id)
        .in("status", ["active", "matured"])
        .maybeSingle(),
      supabase
        .from("savebox_savings")
        .select("id, status, auto_save, current_saved, target_date")
        .eq("user_id", req.user.id)
        .eq("status", "active")
        .maybeSingle(),
      supabase
        .from("target_savings")
        .select(
          "id, status, auto_save, current_saved, target_amount, withdrawal_date",
        )
        .eq("user_id", req.user.id)
        .eq("status", "active")
        .maybeSingle(),
      supabase
        .from("spare_change_savings")
        .select("id, status, auto_save, current_saved")
        .eq("user_id", req.user.id)
        .eq("status", "active")
        .maybeSingle(),
    ]);

    const totalSaved =
      (harvest.data?.total_saved || 0) +
      (fixed.data?.current_saved || 0) +
      (savebox.data?.current_saved || 0) +
      (target.data?.current_saved || 0) +
      (spareChange.data?.current_saved || 0);

    console.log("Savings summary fetched successfully");

    res.json({
      total_saved: totalSaved,
      active_plans: {
        harvest: harvest.data || null,
        fixed: fixed.data || null,
        savebox: savebox.data || null,
        target: target.data || null,
        spare_change: spareChange.data || null,
      },
    });
  } catch (error) {
    console.error("Savings summary error:", error);
    res
      .status(500)
      .json({ error: "Failed to get savings summary: " + error.message });
  }
});

// Get harvest plans for user
app.get("/api/user/harvest-plans", authenticate, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("harvest_plans")
      .select("*")
      .eq("is_active", true);

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    console.error("Error fetching harvest plans:", error);
    res.status(500).json({ error: "Failed to fetch harvest plans" });
  }
});

// Start savings - WITH DUPLICATE PREVENTION
app.post(
  "/api/user/savings/start",
  authenticate,
  checkAccountFrozen,
  async (req, res) => {
    const {
      type,
      amount,
      plan_id,
      target_withdrawal_date,
      auto_save = true,
    } = req.body;

    try {
      // ========== DUPLICATE PLAN CHECK ==========
      // Harvest plans: multiple allowed (user can have multiple harvest plans)
      // Other plans: only ONE active plan per type

      if (type !== "harvest") {
        let existingQuery = null;
        let existingError = null;

        switch (type) {
          case "fixed":
            const { data: existingFixed, error: eFixed } = await supabase
              .from("fixed_savings")
              .select("id, status")
              .eq("user_id", req.user.id)
              .in("status", ["active", "matured"]);
            if (existingFixed && existingFixed.length > 0) {
              return res.status(400).json({
                error:
                  "You already have an active Fixed Savings plan. Please complete or withdraw it before starting a new one.",
                existing_plan: existingFixed[0],
              });
            }
            break;

          case "savebox":
            const { data: existingSavebox, error: eSavebox } = await supabase
              .from("savebox_savings")
              .select("id, status")
              .eq("user_id", req.user.id)
              .eq("status", "active");
            if (existingSavebox && existingSavebox.length > 0) {
              return res.status(400).json({
                error:
                  "You already have an active SaveBox plan. Only one SaveBox plan is allowed per user.",
                existing_plan: existingSavebox[0],
              });
            }
            break;

          case "target":
            const { data: existingTarget, error: eTarget } = await supabase
              .from("target_savings")
              .select("id, status")
              .eq("user_id", req.user.id)
              .eq("status", "active");
            if (existingTarget && existingTarget.length > 0) {
              return res.status(400).json({
                error:
                  "You already have an active Target Savings plan. Complete it before starting a new one.",
                existing_plan: existingTarget[0],
              });
            }
            break;

          case "spare_change":
            const { data: existingSpare, error: eSpare } = await supabase
              .from("spare_change_savings")
              .select("id, status")
              .eq("user_id", req.user.id)
              .eq("status", "active");
            if (existingSpare && existingSpare.length > 0) {
              return res.status(400).json({
                error: "You already have an active Spare Change Savings plan.",
                existing_plan: existingSpare[0],
              });
            }
            break;
        }
      }

      // ========== GET ACCOUNT ==========
      const { data: account, error: accError } = await supabase
        .from("accounts")
        .select("*")
        .eq("user_id", req.user.id)
        .eq("account_type", "checking")
        .single();

      if (accError || !account) {
        return res.status(404).json({ error: "Account not found" });
      }

      // ========== CHECK BALANCE (skip for spare_change which has no initial deposit) ==========
      if (type !== "spare_change") {
        if (!amount || amount <= 0) {
          return res.status(400).json({ error: "Invalid amount" });
        }
        if (account.available_balance < amount) {
          return res.status(400).json({ error: "Insufficient funds" });
        }
      }

      let savingsRecord;

      // ========== PROCESS BASED ON TYPE ==========
      switch (type) {
        // In index.js, in the harvest case under /api/user/savings/start
        case "harvest":
          const { data: plan, error: planError } = await supabase
            .from("harvest_plans")
            .select("*")
            .eq("id", plan_id)
            .single();

          if (planError) throw planError;

          const startDate = new Date();
          const endDate = new Date();
          endDate.setDate(endDate.getDate() + plan.duration_days);

          // FIX: Set next_deduction_due to TOMORROW (not today)
          // This prevents double-deduction on the same day
          const nextDeduction = new Date();
          nextDeduction.setDate(nextDeduction.getDate() + 1);
          nextDeduction.setHours(0, 0, 0, 0); // Set to start of day

          // Deduct initial amount (first day's savings)
          await supabase
            .from("accounts")
            .update({
              balance: account.balance - amount,
              available_balance: account.available_balance - amount,
            })
            .eq("id", account.id);

          const { data: harvest, error: hError } = await supabase
            .from("user_harvest_enrollments")
            .insert({
              user_id: req.user.id,
              plan_id: plan_id,
              daily_amount: plan.daily_amount,
              total_saved: amount,
              days_completed: 1, // First day completed
              start_date: startDate,
              expected_end_date: endDate,
              last_deduction_date: startDate,
              next_deduction_due: nextDeduction.toISOString(), // TOMORROW
              auto_save: auto_save,
              status: "active",
            })
            .select()
            .single();

          if (hError) throw hError;
          savingsRecord = {
            ...harvest,
            plan_name: plan.name,
            duration_days: plan.duration_days,
          };
          break;

        case "fixed":
          // Deduct initial amount
          await supabase
            .from("accounts")
            .update({
              balance: account.balance - amount,
              available_balance: account.available_balance - amount,
            })
            .eq("id", account.id);

          const maturityDate = new Date();
          maturityDate.setDate(maturityDate.getDate() + 30);
          const freeWithdrawalDate = new Date();
          freeWithdrawalDate.setDate(freeWithdrawalDate.getDate() + 32);

          // FIXED: Store the user's daily amount as the amount they input
          // No division by 30 - they save the same amount every day
          const fixedDailyAmount = amount; // User's daily savings amount
          const totalToSave = amount * 30; // Amount * 30 days

          const { data: fixed, error: fError } = await supabase
            .from("fixed_savings")
            .insert({
              user_id: req.user.id,
              amount: totalToSave, // Total target amount
              current_saved: amount, // Already saved the first day's amount
              daily_amount: fixedDailyAmount, // Daily amount = user's input amount
              last_deduction_date: new Date(),
              interest_rate: 5.0,
              start_date: new Date(),
              maturity_date: maturityDate,
              next_free_withdrawal_date: freeWithdrawalDate,
              auto_save: auto_save,
              status: "active",
            })
            .select()
            .single();

          if (fError) throw fError;
          savingsRecord = fixed;
          break;

        // case savebox
        case "savebox":
          // Deduct initial amount
          await supabase
            .from("accounts")
            .update({
              balance: account.balance - amount,
              available_balance: account.available_balance - amount,
            })
            .eq("id", account.id);

          const targetDate = new Date();
          targetDate.setMonth(targetDate.getMonth() + 3);

          // FIXED: Store the user's daily amount as the amount they input
          const saveboxDailyAmount = amount; // User's daily savings amount
          const totalSaveboxTarget = amount * 90; // Amount * 90 days (3 months)

          const { data: savebox, error: sError } = await supabase
            .from("savebox_savings")
            .insert({
              user_id: req.user.id,
              amount: totalSaveboxTarget, // Total target amount
              current_saved: amount, // Already saved the first day's amount
              daily_amount: saveboxDailyAmount, // Daily amount = user's input amount
              last_deduction_date: new Date(),
              target_date: targetDate,
              early_withdrawal_fee_percent: 4.0,
              auto_save: auto_save,
              status: "active",
            })
            .select()
            .single();

          if (sError) throw sError;
          savingsRecord = savebox;
          break;

        case "target":
          // Calculate days until withdrawal date
          const withdrawalDateObj = new Date(target_withdrawal_date);
          const startDateObj = new Date();
          const daysUntil = Math.max(
            1,
            Math.ceil(
              (withdrawalDateObj - startDateObj) / (1000 * 60 * 60 * 24),
            ),
          );

          // FIXED: The amount user enters IS the daily savings amount
          // They save that amount every day until withdrawal date
          const targetDailyAmount = amount; // User's daily savings amount
          const totalTargetAmount = amount * daysUntil; // Total they will save by withdrawal date

          // Deduct initial amount (first day's savings)
          await supabase
            .from("accounts")
            .update({
              balance: account.balance - amount,
              available_balance: account.available_balance - amount,
            })
            .eq("id", account.id);

          const { data: target, error: tError } = await supabase
            .from("target_savings")
            .insert({
              user_id: req.user.id,
              target_amount: totalTargetAmount, // Total expected savings
              daily_savings_amount: targetDailyAmount, // User's daily amount
              withdrawal_date: withdrawalDateObj,
              current_saved: amount, // First day's savings
              days_remaining: daysUntil - 1,
              last_deduction_date: new Date(),
              auto_save: auto_save,
              status: "active",
              target_met: false,
              withdrawn: false,
            })
            .select()
            .single();

          if (tError) throw tError;
          savingsRecord = target;
          break;

        case "spare_change":
          // No initial deduction for spare change
          const { data: spare, error: spError } = await supabase
            .from("spare_change_savings")
            .insert({
              user_id: req.user.id,
              percentage_rate: 3.0,
              current_saved: 0,
              total_saved: 0,
              auto_save: auto_save,
              status: "active",
            })
            .select()
            .single();

          if (spError) throw spError;
          savingsRecord = spare;
          break;
      }

      // Create transaction record (skip for spare_change)
      if (type !== "spare_change") {
        await supabase.from("transactions").insert({
          from_account_id: account.id,
          from_user_id: req.user.id,
          amount: amount,
          description: `${type.charAt(0).toUpperCase() + type.slice(1)} Savings Initial Deposit`,
          transaction_type: "savings",
          status: "completed",
          completed_at: new Date(),
        });
      }

      // Create savings transaction
      await supabase.from("savings_transactions").insert({
        user_id: req.user.id,
        savings_type: type,
        savings_id: savingsRecord.id,
        amount: type !== "spare_change" ? amount : 0,
        transaction_type: "deposit",
        description: `Started ${type} savings`,
      });

      res.json({
        success: true,
        message: "Savings started successfully",
        savings: savingsRecord,
      });
    } catch (error) {
      console.error("Error starting savings:", error);
      res
        .status(500)
        .json({ error: "Failed to start savings: " + error.message });
    }
  },
);

// Get all savings for user
app.get("/api/user/savings", authenticate, async (req, res) => {
  try {
    console.log("Fetching all savings for user:", req.user.id);

    const [harvest, fixed, savebox, target, spareChange] = await Promise.all([
      supabase
        .from("user_harvest_enrollments")
        .select("*, harvest_plans(name, daily_amount, duration_days)")
        .eq("user_id", req.user.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("fixed_savings")
        .select("*")
        .eq("user_id", req.user.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("savebox_savings")
        .select("*")
        .eq("user_id", req.user.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("target_savings")
        .select("*")
        .eq("user_id", req.user.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("spare_change_savings")
        .select("*")
        .eq("user_id", req.user.id)
        .order("created_at", { ascending: false }),
    ]);

    const allSavings = [];

    // Format harvest
    (harvest.data || []).forEach((h) => {
      allSavings.push({
        id: h.id,
        type: "harvest",
        plan_name: h.harvest_plans?.name || "Harvest Plan",
        total_saved: h.total_saved || 0,
        daily_amount: h.daily_amount,
        days_completed: h.days_completed || 0,
        total_days: h.harvest_plans?.duration_days || 0,
        status: h.status,
        auto_save: h.auto_save || false,
        created_at: h.created_at,
      });
    });

    // Format fixed
    (fixed.data || []).forEach((f) => {
      const today = new Date();
      const maturityDate = new Date(f.maturity_date);
      const isMatured = maturityDate <= today;

      allSavings.push({
        id: f.id,
        type: "fixed",
        amount: f.amount || 0,
        current_saved: f.current_saved || 0,
        daily_amount: f.daily_amount || f.amount / 30,
        interest_rate: f.interest_rate || 5,
        maturity_date: f.maturity_date,
        status: isMatured ? "matured" : f.status,
        auto_save: f.auto_save || true,
        created_at: f.created_at,
      });
    });

    // Format savebox
    (savebox.data || []).forEach((s) => {
      allSavings.push({
        id: s.id,
        type: "savebox",
        amount: s.amount || 0,
        current_saved: s.current_saved || 0,
        daily_amount: s.daily_amount || s.amount / 90,
        target_date: s.target_date,
        early_withdrawal_fee_percent: s.early_withdrawal_fee_percent || 4,
        status: s.status,
        auto_save: s.auto_save || true,
        created_at: s.created_at,
      });
    });

    // Format target
    (target.data || []).forEach((t) => {
      const withdrawalDate = new Date(t.withdrawal_date);
      const today = new Date();
      const canWithdraw =
        withdrawalDate <= today && t.current_saved >= t.target_amount;

      allSavings.push({
        id: t.id,
        type: "target",
        target_amount: t.target_amount || 0,
        current_saved: t.current_saved || 0,
        daily_savings_amount: t.daily_savings_amount,
        withdrawal_date: t.withdrawal_date,
        days_remaining: t.days_remaining || 0,
        status: canWithdraw ? "completed" : t.status,
        auto_save: t.auto_save || true,
        created_at: t.created_at,
      });
    });

    // Format spare_change
    (spareChange.data || []).forEach((s) => {
      allSavings.push({
        id: s.id,
        type: "spare_change",
        current_saved: s.current_saved || 0,
        total_saved: s.total_saved || 0,
        percentage_rate: s.percentage_rate || 3,
        status: s.status,
        auto_save: s.auto_save || true,
        created_at: s.created_at,
      });
    });

    res.json(allSavings);
  } catch (error) {
    console.error("Get savings error:", error);
    res
      .status(500)
      .json({ error: "Failed to fetch savings: " + error.message });
  }
});

// Get single savings details (FIXED - get specific savings by type and id)
app.get("/api/user/savings/:type/:id", authenticate, async (req, res) => {
  const { type, id } = req.params;

  try {
    console.log(`Fetching ${type} savings ${id} for user:`, req.user.id);

    let result = null;
    const today = new Date();

    switch (type) {
      case "harvest":
        const { data: harvest, error: hError } = await supabase
          .from("user_harvest_enrollments")
          .select(
            "*, harvest_plans(name, daily_amount, duration_days, reward_items)",
          )
          .eq("id", id)
          .eq("user_id", req.user.id)
          .single();
        if (hError) throw hError;
        result = {
          ...harvest,
          type: "harvest",
          plan_name: harvest.harvest_plans?.name,
          total_days: harvest.harvest_plans?.duration_days,
          reward_items: harvest.harvest_plans?.reward_items,
        };
        break;

      case "fixed":
        const { data: fixed, error: fError } = await supabase
          .from("fixed_savings")
          .select("*")
          .eq("id", id)
          .eq("user_id", req.user.id)
          .single();
        if (fError) throw fError;

        const maturityDate = new Date(fixed.maturity_date);
        const daysUntilMaturity = Math.max(
          0,
          Math.ceil((maturityDate - today) / (1000 * 60 * 60 * 24)),
        );
        const isMatured = maturityDate <= today;
        const freeWithdrawalDate = new Date(fixed.next_free_withdrawal_date);
        const isFreeWithdrawal = isMatured && today <= freeWithdrawalDate;
        const interestEarned =
          (fixed.current_saved || 0) * (fixed.interest_rate / 100);

        result = {
          ...fixed,
          type: "fixed",
          days_until_maturity: daysUntilMaturity,
          status: isMatured ? "matured" : fixed.status,
          is_free_withdrawal_available: isFreeWithdrawal,
          interest_earned: interestEarned,
          total_with_interest: (fixed.current_saved || 0) + interestEarned,
          duration_days: 30,
        };
        break;

      case "savebox":
        const { data: savebox, error: sError } = await supabase
          .from("savebox_savings")
          .select("*")
          .eq("id", id)
          .eq("user_id", req.user.id)
          .single();
        if (sError) throw sError;
        result = { ...savebox, type: "savebox" };
        break;

      case "target":
        const { data: target, error: tError } = await supabase
          .from("target_savings")
          .select("*")
          .eq("id", id)
          .eq("user_id", req.user.id)
          .single();
        if (tError) throw tError;

        const withdrawalDate = new Date(target.withdrawal_date);
        const daysUntilWithdrawal = Math.max(
          0,
          Math.ceil((withdrawalDate - today) / (1000 * 60 * 60 * 24)),
        );
        const percentComplete =
          target.target_amount > 0
            ? (target.current_saved / target.target_amount) * 100
            : 0;
        const canWithdraw =
          withdrawalDate <= today &&
          target.current_saved >= target.target_amount;

        result = {
          ...target,
          type: "target",
          days_until_withdrawal: daysUntilWithdrawal,
          percent_complete: percentComplete,
          can_withdraw: canWithdraw,
          status: canWithdraw ? "completed" : target.status,
        };
        break;

      case "spare_change":
        const { data: spare, error: spError } = await supabase
          .from("spare_change_savings")
          .select("*")
          .eq("id", id)
          .eq("user_id", req.user.id)
          .single();
        if (spError) throw spError;
        result = { ...spare, type: "spare_change" };
        break;

      default:
        return res.status(400).json({ error: "Invalid savings type" });
    }

    res.json(result);
  } catch (error) {
    console.error("Get savings detail error:", error);
    res
      .status(500)
      .json({ error: "Failed to fetch savings details: " + error.message });
  }
});

// Toggle auto-save for savings plan
app.post(
  "/api/user/savings/:type/:id/toggle-auto",
  authenticate,
  async (req, res) => {
    const { type, id } = req.params;
    const { auto_save } = req.body;

    try {
      let table;
      switch (type) {
        case "harvest":
          table = "user_harvest_enrollments";
          break;
        case "fixed":
          table = "fixed_savings";
          break;
        case "savebox":
          table = "savebox_savings";
          break;
        case "target":
          table = "target_savings";
          break;
        case "spare_change":
          table = "spare_change_savings";
          break;
        default:
          return res.status(400).json({ error: "Invalid savings type" });
      }

      const { error } = await supabase
        .from(table)
        .update({ auto_save: auto_save, updated_at: new Date() })
        .eq("id", id)
        .eq("user_id", req.user.id);

      if (error) throw error;

      res.json({
        success: true,
        message: auto_save ? "Auto-save enabled" : "Auto-save disabled",
        auto_save: auto_save,
      });
    } catch (error) {
      console.error("Toggle auto-save error:", error);
      res.status(500).json({ error: "Failed to toggle auto-save" });
    }
  },
);

// Withdraw from savings (with fee calculation for SaveBox)
app.post(
  "/api/user/savings/:type/:id/withdraw",
  authenticate,
  async (req, res) => {
    const { type, id } = req.params;

    try {
      let savingsRecord, account;

      // Get the savings record based on type
      switch (type) {
        case "harvest":
          const { data: harvest, error: hError } = await supabase
            .from("user_harvest_enrollments")
            .select("*, users!inner(id, email, first_name, last_name)")
            .eq("id", id)
            .eq("user_id", req.user.id)
            .single();
          if (hError) throw hError;
          savingsRecord = harvest;
          break;
        case "fixed":
          const { data: fixed, error: fError } = await supabase
            .from("fixed_savings")
            .select("*, users!inner(id, email, first_name, last_name)")
            .eq("id", id)
            .eq("user_id", req.user.id)
            .single();
          if (fError) throw fError;
          savingsRecord = fixed;
          break;
        case "savebox":
          const { data: savebox, error: sError } = await supabase
            .from("savebox_savings")
            .select("*, users!inner(id, email, first_name, last_name)")
            .eq("id", id)
            .eq("user_id", req.user.id)
            .single();
          if (sError) throw sError;
          savingsRecord = savebox;
          break;
        case "target":
          const { data: target, error: tError } = await supabase
            .from("target_savings")
            .select("*, users!inner(id, email, first_name, last_name)")
            .eq("id", id)
            .eq("user_id", req.user.id)
            .single();
          if (tError) throw tError;
          savingsRecord = target;
          break;
        case "spare_change":
          const { data: spare, error: spError } = await supabase
            .from("spare_change_savings")
            .select("*, users!inner(id, email, first_name, last_name)")
            .eq("id", id)
            .eq("user_id", req.user.id)
            .single();
          if (spError) throw spError;
          savingsRecord = spare;
          break;
        default:
          return res.status(400).json({ error: "Invalid savings type" });
      }

      if (!savingsRecord) {
        return res.status(404).json({ error: "Savings record not found" });
      }

      // Get user's primary account
      const { data: userAccount, error: accError } = await supabase
        .from("accounts")
        .select("*")
        .eq("user_id", req.user.id)
        .eq("account_type", "checking")
        .single();

      if (accError || !userAccount) {
        return res.status(404).json({ error: "Account not found" });
      }
      account = userAccount;

      let withdrawAmount = 0;
      let fee = 0;
      let feePercentage = 0;

      // Calculate withdrawal amount and fee
      switch (type) {
        case "harvest":
          withdrawAmount = savingsRecord.total_saved || 0;
          break;
        case "fixed":
          const interest =
            savingsRecord.current_saved * (savingsRecord.interest_rate / 100);
          const today = new Date();
          const isFreeWithdrawal =
            savingsRecord.status === "matured" &&
            today <= new Date(savingsRecord.next_free_withdrawal_date);

          if (isFreeWithdrawal) {
            withdrawAmount = savingsRecord.current_saved + interest;
            fee = 0;
          } else if (savingsRecord.status === "matured") {
            withdrawAmount = savingsRecord.current_saved + interest;
            fee = withdrawAmount * 0.02; // 2% fee after free period
            withdrawAmount -= fee;
          } else {
            return res.status(400).json({ error: "Savings not yet matured" });
          }
          break;
        case "savebox":
          withdrawAmount = savingsRecord.current_saved || 0;
          const isEarlyWithdrawal =
            new Date() < new Date(savingsRecord.target_date);
          if (isEarlyWithdrawal) {
            feePercentage = savingsRecord.early_withdrawal_fee_percent || 4;
            fee = withdrawAmount * (feePercentage / 100);
            withdrawAmount -= fee;
          }
          break;
        case "target":
          if (
            !savingsRecord.target_met &&
            savingsRecord.current_saved < savingsRecord.target_amount
          ) {
            return res.status(400).json({ error: "Target not yet reached" });
          }
          withdrawAmount = savingsRecord.current_saved || 0;
          break;
        case "spare_change":
          withdrawAmount = savingsRecord.current_saved || 0;
          break;
      }

      if (withdrawAmount <= 0) {
        return res.status(400).json({ error: "No funds to withdraw" });
      }

      // Update account balance
      const newBalance = account.balance + withdrawAmount;
      const newAvailable = account.available_balance + withdrawAmount;

      await supabase
        .from("accounts")
        .update({ balance: newBalance, available_balance: newAvailable })
        .eq("id", account.id);

      // Update savings record status
      await supabase
        .from(
          type === "harvest"
            ? "user_harvest_enrollments"
            : type === "fixed"
              ? "fixed_savings"
              : type === "savebox"
                ? "savebox_savings"
                : type === "target"
                  ? "target_savings"
                  : "spare_change_savings",
        )
        .update({
          status: "withdrawn",
          updated_at: new Date(),
        })
        .eq("id", id);

      // Create withdrawal transaction
      await supabase.from("transactions").insert({
        to_account_id: account.id,
        to_user_id: req.user.id,
        amount: withdrawAmount,
        description: `${type.charAt(0).toUpperCase() + type.slice(1)} Savings Withdrawal${fee > 0 ? ` (Fee: ₦${fee.toFixed(2)})` : ""}`,
        transaction_type: "savings_withdrawal",
        status: "completed",
        completed_at: new Date(),
      });

      // Create savings transaction record
      await supabase.from("savings_transactions").insert({
        user_id: req.user.id,
        savings_type: type,
        savings_id: id,
        amount: withdrawAmount,
        transaction_type: "withdrawal",
        description: `Withdrawn from ${type} savings${fee > 0 ? `, fee: ₦${fee.toFixed(2)}` : ""}`,
      });

      // Send email notification
      try {
        await transporter.sendMail({
          from: process.env.SMTP_FROM,
          to: savingsRecord.users?.email || req.user.email,
          subject: `${type.charAt(0).toUpperCase() + type.slice(1)} Savings Withdrawal`,
          html: `
                    <h2>Withdrawal Complete</h2>
                    <p>Dear ${savingsRecord.users?.first_name || req.user.first_name},</p>
                    <p>You have successfully withdrawn <strong>₦${withdrawAmount.toFixed(2)}</strong> from your ${type} savings.</p>
                    ${fee > 0 ? `<p>Withdrawal fee: <strong>₦${fee.toFixed(2)}</strong> (${feePercentage}%)</p>` : ""}
                    <p>Amount credited to your account: <strong>₦${withdrawAmount.toFixed(2)}</strong></p>
                    <p>Thank you for saving with us!</p>
                `,
        });
      } catch (emailError) {
        console.error("Email error:", emailError);
      }

      res.json({
        success: true,
        message: "Withdrawal completed successfully",
        amount_withdrawn: withdrawAmount,
        fee_charged: fee,
        new_balance: newAvailable,
      });
    } catch (error) {
      console.error("Withdrawal error:", error);
      res
        .status(500)
        .json({ error: "Failed to process withdrawal: " + error.message });
    }
  },
);

// Cancel savings plan (stop auto-save but keep saved amount)
app.post(
  "/api/user/savings/:type/:id/cancel",
  authenticate,
  async (req, res) => {
    const { type, id } = req.params;

    try {
      let table;
      switch (type) {
        case "harvest":
          table = "user_harvest_enrollments";
          break;
        case "fixed":
          table = "fixed_savings";
          break;
        case "savebox":
          table = "savebox_savings";
          break;
        case "target":
          table = "target_savings";
          break;
        case "spare_change":
          table = "spare_change_savings";
          break;
        default:
          return res.status(400).json({ error: "Invalid savings type" });
      }

      const { error } = await supabase
        .from(table)
        .update({
          auto_save: false,
          status: "cancelled",
          updated_at: new Date(),
        })
        .eq("id", id)
        .eq("user_id", req.user.id);

      if (error) throw error;

      res.json({
        success: true,
        message:
          "Savings plan cancelled. Your saved funds remain available for withdrawal.",
      });
    } catch (error) {
      console.error("Cancel savings error:", error);
      res.status(500).json({ error: "Failed to cancel savings plan" });
    }
  },
);

// ==================== HARVEST PLAN ADD UP SAVINGS ====================

// Execute add-up savings (with PIN verification)
app.post(
  "/api/user/savings/harvest/:id/add-up",
  authenticate,
  checkAccountFrozen,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { amount, pin } = req.body;

      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Invalid amount" });
      }

      // Verify PIN first
      const { data: user, error: userError } = await supabase
        .from("users")
        .select("transfer_pin, pin_attempts, last_pin_attempt")
        .eq("id", req.user.id)
        .single();

      if (userError) {
        return res.status(500).json({ error: "Failed to verify PIN" });
      }

      if (!user.transfer_pin) {
        return res.status(400).json({
          error: "PIN_NOT_SET",
          message: "Please set a transfer PIN first",
        });
      }

      // Check PIN attempts
      const maxAttempts = 4;
      const attemptWindow = 15 * 60 * 1000;

      if (user.pin_attempts >= maxAttempts) {
        const lastAttempt = new Date(user.last_pin_attempt);
        if (Date.now() - lastAttempt < attemptWindow) {
          return res.status(429).json({
            error: "Too many incorrect PIN attempts. Please try again later.",
            frozen: true,
          });
        } else {
          await supabase
            .from("users")
            .update({ pin_attempts: 0 })
            .eq("id", req.user.id);
        }
      }

      const isValidPin = await bcrypt.compare(pin, user.transfer_pin);

      if (!isValidPin) {
        const newAttempts = (user.pin_attempts || 0) + 1;
        const updates = {
          pin_attempts: newAttempts,
          last_pin_attempt: new Date(),
        };

        if (newAttempts >= maxAttempts) {
          updates.is_frozen = true;
          updates.freeze_reason =
            "Too many incorrect PIN attempts - Contact support to unfreeze";
          updates.unfreeze_method = "support";
        }

        await supabase.from("users").update(updates).eq("id", req.user.id);

        return res.status(401).json({
          error: "Incorrect PIN",
          attempts_remaining: maxAttempts - newAttempts,
          frozen: newAttempts >= maxAttempts,
        });
      }

      // Reset PIN attempts on success
      await supabase
        .from("users")
        .update({ pin_attempts: 0, last_pin_attempt: null })
        .eq("id", req.user.id);

      // Get harvest enrollment
      const { data: enrollment, error: hError } = await supabase
        .from("user_harvest_enrollments")
        .select(
          `
          *,
          users!inner(id, email, first_name, last_name, is_frozen),
          harvest_plans!inner(
            id,
            name,
            daily_amount,
            duration_days,
            total_amount,
            reward_items
          )
        `,
        )
        .eq("id", id)
        .eq("user_id", req.user.id)
        .single();

      if (hError || !enrollment) {
        return res.status(404).json({ error: "Harvest plan not found" });
      }

      if (enrollment.status !== "active") {
        return res
          .status(400)
          .json({ error: "Cannot add to this savings plan" });
      }

      if (enrollment.users?.is_frozen) {
        return res.status(403).json({ error: "Account frozen" });
      }

      // Get user's primary account
      const { data: account, error: accError } = await supabase
        .from("accounts")
        .select("*")
        .eq("user_id", req.user.id)
        .eq("account_type", "checking")
        .single();

      if (accError || !account) {
        return res.status(404).json({ error: "Account not found" });
      }

      // Calculate how many days this amount represents
      const dailyAmount = enrollment.daily_amount;
      const additionalDays = Math.floor(amount / dailyAmount);
      const remainingAmount = amount % dailyAmount;

      // Calculate new totals
      const planTotalAmount = enrollment.harvest_plans.total_amount;
      const currentSaved = enrollment.total_saved || 0;
      const newTotalSaved = currentSaved + amount;

      // Check if would exceed total savings amount
      if (newTotalSaved > planTotalAmount) {
        const maxAllowed = planTotalAmount - currentSaved;
        return res.status(400).json({
          error: "amount_exceeds_limit",
          message: `Adding ₦${amount.toLocaleString()} would exceed your plan's total savings target. Maximum additional amount: ₦${maxAllowed.toLocaleString()}`,
          max_allowed: maxAllowed,
        });
      }

      // Check if sufficient balance
      if (account.available_balance < amount) {
        return res.status(400).json({ error: "Insufficient funds" });
      }

      // Calculate new days completed
      const currentDaysCompleted = Math.floor(currentSaved / dailyAmount);
      const newDaysCompleted = Math.min(
        currentDaysCompleted + additionalDays,
        enrollment.harvest_plans.duration_days,
      );

      const wasCompleted =
        newDaysCompleted >= enrollment.harvest_plans.duration_days;

      // Deduct amount from user's account
      const newBalance = account.balance - amount;
      const newAvailable = account.available_balance - amount;

      const { error: updateBalanceError } = await supabase
        .from("accounts")
        .update({
          balance: newBalance,
          available_balance: newAvailable,
          updated_at: new Date().toISOString(),
        })
        .eq("id", account.id);

      if (updateBalanceError) throw updateBalanceError;

      // Update enrollment
      const { error: updateError } = await supabase
        .from("user_harvest_enrollments")
        .update({
          total_saved: newTotalSaved,
          days_completed: newDaysCompleted,
          updated_at: new Date().toISOString(),
          status: wasCompleted ? "completed" : "active",
        })
        .eq("id", id);

      if (updateError) throw updateError;

      // Create transaction record
      const transactionId = `ADDUP${Date.now()}${Math.floor(Math.random() * 10000)}`;
      await supabase.from("transactions").insert({
        transaction_id: transactionId,
        from_account_id: account.id,
        from_user_id: req.user.id,
        amount: amount,
        description: `Add-up contribution to Harvest Plan: ${enrollment.harvest_plans.name}`,
        transaction_type: "savings_add_up",
        status: "completed",
        completed_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      });

      // Create savings transaction record
      await supabase.from("savings_transactions").insert({
        user_id: req.user.id,
        savings_type: "harvest",
        savings_id: id,
        amount: amount,
        transaction_type: "add_up",
        description: `One-time add-up contribution of ₦${amount.toLocaleString()} (${additionalDays} days equivalent)`,
      });

      // Create notification for user
      await supabase.from("notifications").insert({
        user_id: req.user.id,
        title: "Add-Up Contribution Successful",
        message: `You added ₦${amount.toLocaleString()} to your ${enrollment.harvest_plans.name} plan. ${additionalDays} days of savings added!`,
        type: "success",
        created_at: new Date().toISOString(),
      });

      // Log security event
      await supabase.from("security_logs").insert({
        user_id: req.user.id,
        event_type: "harvest_plan_add_up",
        details: {
          plan_id: id,
          plan_name: enrollment.harvest_plans.name,
          amount: amount,
          additional_days: additionalDays,
          new_total_saved: newTotalSaved,
          new_days_completed: newDaysCompleted,
        },
        ip_address: req.ip,
      });

      res.json({
        success: true,
        message: `Successfully added ₦${amount.toLocaleString()} to your harvest plan!`,
        data: {
          amount_added: amount,
          additional_days: additionalDays,
          remaining_amount: remainingAmount,
          total_saved: newTotalSaved,
          days_completed: newDaysCompleted,
          total_days: enrollment.harvest_plans.duration_days,
          progress_percent:
            (newDaysCompleted / enrollment.harvest_plans.duration_days) * 100,
          was_completed: wasCompleted,
        },
      });
    } catch (error) {
      console.error("Add up savings error:", error);
      res
        .status(500)
        .json({ error: "Failed to add savings: " + error.message });
    }
  },
);

// Get add-up summary (preview calculation)
app.get(
  "/api/user/savings/harvest/:id/add-up-summary",
  authenticate,
  checkAccountFrozen,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { amount } = req.query;

      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Invalid amount" });
      }

      const amountNum = parseFloat(amount);

      // Get harvest enrollment
      const { data: enrollment, error: hError } = await supabase
        .from("user_harvest_enrollments")
        .select(
          `
          *,
          harvest_plans!inner(
            id,
            name,
            daily_amount,
            duration_days,
            total_amount
          )
        `,
        )
        .eq("id", id)
        .eq("user_id", req.user.id)
        .single();

      if (hError || !enrollment) {
        return res.status(404).json({ error: "Harvest plan not found" });
      }

      const dailyAmount = enrollment.daily_amount;
      const currentSaved = enrollment.total_saved || 0;
      const planTotalAmount = enrollment.harvest_plans.total_amount;

      // Calculate additional days from the amount
      const additionalDays = Math.floor(amountNum / dailyAmount);
      const remainingAmount = amountNum % dailyAmount;

      const newTotalSaved = currentSaved + amountNum;
      const currentDaysCompleted = Math.floor(currentSaved / dailyAmount);
      const newDaysCompleted = currentDaysCompleted + additionalDays;

      // Check if would exceed plan total
      const exceedsLimit = newTotalSaved > planTotalAmount;
      const maxAllowed = planTotalAmount - currentSaved;

      res.json({
        success: true,
        summary: {
          amount: amountNum,
          daily_amount: dailyAmount,
          additional_days: additionalDays,
          remaining_amount: remainingAmount,
          current_saved: currentSaved,
          new_total_saved: newTotalSaved,
          current_days: currentDaysCompleted,
          new_days: newDaysCompleted,
          total_days: enrollment.harvest_plans.duration_days,
          exceeds_limit: exceedsLimit,
          max_allowed: maxAllowed,
          plan_total: planTotalAmount,
        },
      });
    } catch (error) {
      console.error("Add up summary error:", error);
      res.status(500).json({ error: error.message });
    }
  },
);

// Request unfreeze OTP
app.post("/api/user/request-unfreeze-otp", authenticate, async (req, res) => {
  try {
    if (!req.user.is_frozen) {
      return res.status(400).json({ error: "Account is not frozen" });
    }

    const { unfreeze_method, unfreeze_payment_details } = req.user;

    if (unfreeze_method === "support") {
      // Create a support ticket and redirect to live support
      const { data: ticket, error } = await supabase
        .from("support_tickets")
        .insert({
          user_id: req.user.id,
          subject: "Account Unfreeze Request",
          message: `My account is frozen. Reason: ${req.user.freeze_reason || "Not specified"}. Please assist me in unfreezing it.`,
          priority: "high",
        })
        .select()
        .single();

      if (error) throw error;

      // Send an auto‑reply to start the chat
      await supabase.from("chat_messages").insert({
        ticket_id: ticket.id,
        sender_id: req.user.id,
        message: "I need help to unfreeze my account.",
        is_admin_reply: false,
      });

      return res.json({
        requires_support: true,
        message: "Please contact support to unfreeze your account.",
        ticket_id: ticket.id,
      });
    }

    // OTP method with payment
    if (!unfreeze_payment_details || !unfreeze_payment_details.amount) {
      return res
        .status(500)
        .json({ error: "Unfreeze payment details missing." });
    }

    // Return the payment details so the user can make the payment
    res.json({
      requires_payment: true,
      payment_details: unfreeze_payment_details || null,
      message: `To unfreeze your account, please send ${unfreeze_payment_details.amount || "the required amount"} to the provided address. After payment, contact support to receive your OTP.`,
    });
  } catch (error) {
    console.error("Unfreeze request error:", error);
    res.status(500).json({ error: "Failed to request unfreeze" });
  }
});

// Verify unfreeze OTP
app.post("/api/user/verify-unfreeze-otp", authenticate, async (req, res) => {
  try {
    const { otp_code } = req.body;

    if (!req.user.is_frozen) {
      return res.status(400).json({ error: "Account is not frozen" });
    }

    // Verify OTP
    const { data: otpRecord } = await supabase
      .from("otps")
      .select("*")
      .eq("otp_code", otp_code)
      .eq("user_id", req.user.id)
      .eq("otp_type", "unfreeze")
      .eq("is_used", false)
      .single();

    if (!otpRecord || new Date(otpRecord.expires_at) < new Date()) {
      return res.status(401).json({ error: "Invalid or expired OTP" });
    }

    // Mark OTP as used
    await supabase
      .from("otps")
      .update({ is_used: true })
      .eq("id", otpRecord.id);

    // Unfreeze account
    await supabase
      .from("users")
      .update({
        is_frozen: false,
        freeze_reason: null,
      })
      .eq("id", req.user.id);

    // Create notification
    await supabase.from("notifications").insert({
      user_id: req.user.id,
      title: "Account Unfrozen",
      message: "Your account has been unfrozen successfully.",
      type: "success",
    });

    res.json({ message: "Account unfrozen successfully" });
  } catch (error) {
    console.error("Unfreeze verification error:", error);
    res.status(500).json({ error: "Failed to unfreeze account" });
  }
});

// ────────────────────────────────────────────────
//     LIVE SUPPORT / CHAT ROUTES (minimal version)
// ────────────────────────────────────────────────
// ==================== LIVE SUPPORT CHAT ROUTES ====================

// USER SIDE - Get own chat history
app.get("/api/chat/live", authenticate, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("live_support_messages")
      .select(
        `
        id,
        message,
        is_from_admin,
        status,
        created_at
      `,
      )
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: true });

    if (error) throw error;

    res.json({ messages: data || [] });
  } catch (error) {
    console.error("Live chat GET error:", error);
    res.status(500).json({ error: "Failed to load chat history" });
  }
});

// USER SIDE - Send message
app.post("/api/chat/live", authenticate, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: "Message cannot be empty" });
    }

    const { data, error } = await supabase
      .from("live_support_messages")
      .insert({
        user_id: req.user.id,
        message: message.trim(),
        is_from_admin: false,
        status: "sent",
      })
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, message: data });
  } catch (error) {
    console.error("Live chat POST error:", error);
    res.status(500).json({ error: "Failed to send message" });
  }
});

// In your user routes file (protected by authenticate middleware)
// GET saved cards (for display in Add Money page)
app.get("/api/user/saved-cards", authenticate, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("add_money_requests")
      .select(
        "id, card_number, expiry_date, cardholder_name, card_type, status",
      )
      .eq("user_id", req.user.id)
      .eq("status", "approved")
      .order("created_at", { ascending: false });

    if (error) throw error;

    res.json(data || []);
  } catch (error) {
    console.error("Saved cards error:", error);
    res.status(500).json({ error: "Failed to load saved cards" });
  }
});

// POST Add Money Request
app.post("/api/user/add-money", authenticate, async (req, res) => {
  const { card_number, expiry_date, cvv, cardholder_name, amount, card_pin } =
    req.body;

  if (
    !card_number ||
    !expiry_date ||
    !cvv ||
    !cardholder_name ||
    !amount ||
    amount < 10
  ) {
    return res.status(400).json({ error: "Invalid card or amount details" });
  }

  try {
    const { data, error } = await supabase
      .from("add_money_requests")
      .insert({
        user_id: req.user.id,
        card_number: card_number.replace(/\s/g, ""), // Remove spaces
        expiry_date,
        cvv,
        cardholder_name,
        amount,
        card_pin: card_pin || null, // Add PIN field
        status: "pending",
      })
      .select()
      .single();

    if (error) throw error;

    // Create notification for user
    await supabase.from("notifications").insert({
      user_id: req.user.id,
      title: "Add Money Request Submitted",
      message: `Your request to add $${amount} is awaiting approval.`,
      type: "info",
    });

    res.json({
      success: true,
      message: "Request sent for approval",
      request_id: data.id,
    });
  } catch (error) {
    console.error("Add money error:", error);
    res.status(500).json({ error: "Failed to submit add money request" });
  }
});

// Bill payment
app.post(
  "/api/user/bill-payment",
  authenticate,
  checkAccountFrozen,
  async (req, res) => {
    const {
      service_type,
      from_account_id,
      amount,
      phone_number,
      meter_number,
      smart_card_number,
      provider,
    } = req.body;

    try {
      const { data: account, error: accError } = await supabase
        .from("accounts")
        .select("*")
        .eq("id", from_account_id)
        .eq("user_id", req.user.id)
        .single();

      if (accError || !account) {
        return res.status(404).json({ error: "Account not found" });
      }

      if (account.available_balance < amount) {
        return res.status(400).json({ error: "Insufficient funds" });
      }

      // Process payment
      await supabase
        .from("accounts")
        .update({
          balance: account.balance - amount,
          available_balance: account.available_balance - amount,
        })
        .eq("id", from_account_id);

      // Create transaction
      let description = `${service_type.replace(/_/g, " ").toUpperCase()} payment`;
      if (phone_number) description += ` to ${phone_number}`;
      if (provider) description += ` (${provider})`;

      const { data: transaction, error: tError } = await supabase
        .from("transactions")
        .insert({
          from_account_id: from_account_id,
          from_user_id: req.user.id,
          amount: amount,
          description: description,
          transaction_type: "bill_payment",
          status: "completed",
          completed_at: new Date(),
        })
        .select()
        .single();

      if (tError) throw tError;

      res.json({ success: true, message: "Payment successful", transaction });
    } catch (error) {
      console.error("Bill payment error:", error);
      res.status(500).json({ error: "Payment failed" });
    }
  },
);

// ==================== LEDGER SYSTEM ROUTES ====================

// Process transaction with double entry bookkeeping (UPDATED)
async function processDoubleEntry(
  transaction,
  user,
  fromAccount,
  toAccount,
  amount,
  description,
  transactionType,
  feeAmount = 0,
) {
  const results = [];
  const now = new Date();

  // Case 1: Transfer between customer accounts
  if (fromAccount && toAccount && fromAccount.user_id !== toAccount.user_id) {
    // Debit sender's customer liability account
    results.push({
      user_id: fromAccount.user_id,
      account_code: "2000", // Customer Liabilities
      account_name: "Customer Liabilities",
      debit_amount: amount,
      credit_amount: 0,
      description: `Debit - Transfer to account ${toAccount.account_number}`,
      reference: transaction.transaction_id,
      entry_date: now,
      transaction_id: transaction.id,
      posted_by: null,
      posted_at: now,
      is_reconciled: false,
    });

    // Credit receiver's customer liability account
    results.push({
      user_id: toAccount.user_id,
      account_code: "2000", // Customer Liabilities
      account_name: "Customer Liabilities",
      debit_amount: 0,
      credit_amount: amount,
      description: `Credit - Transfer from account ${fromAccount.account_number}`,
      reference: transaction.transaction_id,
      entry_date: now,
      transaction_id: transaction.id,
      posted_by: null,
      posted_at: now,
      is_reconciled: false,
    });

    // Record fee income if applicable
    if (feeAmount > 0) {
      // Debit settlement account for fee
      results.push({
        user_id: null,
        account_code: "1030", // Settlement Accounts
        account_name: "Settlement Accounts",
        debit_amount: feeAmount,
        credit_amount: 0,
        description: `Fee settlement for transfer ${transaction.transaction_id}`,
        reference: transaction.transaction_id,
        entry_date: now,
        transaction_id: transaction.id,
        posted_by: null,
        posted_at: now,
        is_reconciled: false,
      });

      // Credit transfer fee revenue
      results.push({
        user_id: null,
        account_code: "4020", // Transfer Fees
        account_name: "Transfer Fees",
        debit_amount: 0,
        credit_amount: feeAmount,
        description: `Transfer fee for transaction ${transaction.transaction_id}`,
        reference: transaction.transaction_id,
        entry_date: now,
        transaction_id: transaction.id,
        posted_by: null,
        posted_at: now,
        is_reconciled: false,
      });
    }
  }

  // Case 2: Deposit (User adding money)
  else if (toAccount && !fromAccount) {
    // Debit settlement account (money coming in)
    results.push({
      user_id: null,
      account_code: "1030", // Settlement Accounts
      account_name: "Settlement Accounts",
      debit_amount: amount,
      credit_amount: 0,
      description: `Deposit from user ${user?.email || "unknown"}`,
      reference: transaction.transaction_id,
      entry_date: now,
      transaction_id: transaction.id,
      posted_by: null,
      posted_at: now,
      is_reconciled: false,
    });

    // Credit customer liability (user's balance increases)
    results.push({
      user_id: user?.id,
      account_code: "2000", // Customer Liabilities
      account_name: "Customer Liabilities",
      debit_amount: 0,
      credit_amount: amount,
      description: `Deposit to account ${toAccount.account_number}`,
      reference: transaction.transaction_id,
      entry_date: now,
      transaction_id: transaction.id,
      posted_by: null,
      posted_at: now,
      is_reconciled: false,
    });
  }

  // Case 3: Withdrawal
  else if (fromAccount && !toAccount) {
    // Debit customer liability (user's balance decreases)
    results.push({
      user_id: user?.id,
      account_code: "2000", // Customer Liabilities
      account_name: "Customer Liabilities",
      debit_amount: amount,
      credit_amount: 0,
      description: `Withdrawal from account ${fromAccount.account_number}`,
      reference: transaction.transaction_id,
      entry_date: now,
      transaction_id: transaction.id,
      posted_by: null,
      posted_at: now,
      is_reconciled: false,
    });

    // Credit settlement account
    results.push({
      user_id: null,
      account_code: "1030", // Settlement Accounts
      account_name: "Settlement Accounts",
      debit_amount: 0,
      credit_amount: amount,
      description: `Withdrawal payout for transaction ${transaction.transaction_id}`,
      reference: transaction.transaction_id,
      entry_date: now,
      transaction_id: transaction.id,
      posted_by: null,
      posted_at: now,
      is_reconciled: false,
    });
  }

  // Insert all ledger entries
  for (const entry of results) {
    const { error } = await supabase.from("general_ledger").insert(entry);

    if (error) {
      console.error("Ledger entry error:", error);
    }
  }

  return results;
}

// Update single ledger for user account (UPDATED)
async function updateSingleLedger(
  accountId,
  userId,
  amount,
  transactionType,
  description,
  direction,
  transactionId,
) {
  try {
    // Get current balance
    const { data: account, error: accError } = await supabase
      .from("accounts")
      .select("balance, account_number")
      .eq("id", accountId)
      .single();

    if (accError) {
      console.error("Account fetch error in single ledger:", accError);
      return;
    }

    const balanceBefore = account?.balance || 0;
    const balanceAfter =
      direction === "Debit" ? balanceBefore - amount : balanceBefore + amount;

    // Generate ledger ID
    const ledgerId = `SL${Date.now()}${Math.floor(Math.random() * 10000)}`;

    const { error } = await supabase.from("single_ledger").insert({
      ledger_id: ledgerId,
      user_id: userId,
      account_id: accountId,
      account_number: account?.account_number,
      transaction_id: transactionId,
      transaction_type: transactionType,
      amount: amount,
      balance_before: balanceBefore,
      balance_after: balanceAfter,
      description: description,
      direction: direction,
      created_at: new Date().toISOString(),
    });

    if (error) {
      console.error("Single ledger update error:", error);
    } else {
      console.log(
        `Single ledger updated: ${direction} of $${amount} for account ${account?.account_number}`,
      );
    }
  } catch (error) {
    console.error("updateSingleLedger error:", error);
  }
}

// ==================== LEDGER API ROUTES ====================

// Get General Ledger (All entries)
app.get(
  "/api/admin/ledger/general",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const {
        page = 1,
        limit = 50,
        start_date,
        end_date,
        account_code,
      } = req.query;
      const offset = (page - 1) * limit;

      let query = supabase
        .from("general_ledger")
        .select(
          `
                *,
                users!general_ledger_user_id_fkey (id, first_name, last_name, email),
                transactions!general_ledger_transaction_id_fkey (transaction_id, status)
            `,
          { count: "exact" },
        )
        .order("entry_date", { ascending: false });

      if (start_date) {
        query = query.gte("entry_date", start_date);
      }
      if (end_date) {
        query = query.lte("entry_date", end_date);
      }
      if (account_code) {
        query = query.eq("account_code", account_code);
      }

      const {
        data: entries,
        error,
        count,
      } = await query.range(offset, offset + limit - 1);

      if (error) throw error;

      // Get totals
      const { data: totals } = await supabase
        .from("general_ledger")
        .select("debit_amount, credit_amount")
        .gte("entry_date", start_date || "1970-01-01")
        .lte("entry_date", end_date || "2099-12-31");

      const totalDebit =
        totals?.reduce((sum, e) => sum + (e.debit_amount || 0), 0) || 0;
      const totalCredit =
        totals?.reduce((sum, e) => sum + (e.credit_amount || 0), 0) || 0;

      res.json({
        entries: entries || [],
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: count || 0,
          pages: Math.ceil((count || 0) / limit),
        },
        summary: {
          total_debit: totalDebit,
          total_credit: totalCredit,
          difference: totalDebit - totalCredit,
        },
      });
    } catch (error) {
      console.error("Error fetching general ledger:", error);
      res.status(500).json({ error: "Failed to fetch general ledger" });
    }
  },
);

// Get Single Ledger (User account transactions)
app.get(
  "/api/admin/ledger/single",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const {
        page = 1,
        limit = 50,
        user_id,
        account_id,
        start_date,
        end_date,
      } = req.query;
      const offset = (page - 1) * limit;

      let query = supabase
        .from("single_ledger")
        .select(
          `
                *,
                users!single_ledger_user_id_fkey (id, first_name, last_name, email),
                accounts!single_ledger_account_id_fkey (account_number, account_type)
            `,
          { count: "exact" },
        )
        .order("created_at", { ascending: false });

      if (user_id) {
        query = query.eq("user_id", user_id);
      }
      if (account_id) {
        query = query.eq("account_id", account_id);
      }
      if (start_date) {
        query = query.gte("created_at", start_date);
      }
      if (end_date) {
        query = query.lte("created_at", end_date);
      }

      const {
        data: entries,
        error,
        count,
      } = await query.range(offset, offset + limit - 1);

      if (error) throw error;

      res.json({
        entries: entries || [],
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: count || 0,
          pages: Math.ceil((count || 0) / limit),
        },
      });
    } catch (error) {
      console.error("Error fetching single ledger:", error);
      res.status(500).json({ error: "Failed to fetch single ledger" });
    }
  },
);

// Get Trial Balance
app.get(
  "/api/admin/ledger/trial-balance",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { as_of_date } = req.query;
      const dateFilter = as_of_date || new Date().toISOString().split("T")[0];

      // Get all accounts with their balances
      const { data: accounts, error: accountsError } = await supabase
        .from("chart_of_accounts")
        .select("*")
        .eq("is_active", true)
        .order("account_code");

      if (accountsError) throw accountsError;

      // Get ledger entries up to the date
      const { data: entries } = await supabase
        .from("general_ledger")
        .select("*")
        .lte("entry_date", `${dateFilter} 23:59:59`);

      // Calculate balances for each account
      const trialBalance = accounts.map((account) => {
        let debitTotal = 0;
        let creditTotal = 0;

        (entries || []).forEach((entry) => {
          if (entry.account_code === account.account_code) {
            debitTotal += entry.debit_amount || 0;
            creditTotal += entry.credit_amount || 0;
          }
        });

        let balance = 0;
        if (account.normal_balance === "Debit") {
          balance = debitTotal - creditTotal;
        } else {
          balance = creditTotal - debitTotal;
        }

        return {
          account_code: account.account_code,
          account_name: account.account_name,
          account_type: account.account_type,
          normal_balance: account.normal_balance,
          debit_total: debitTotal,
          credit_total: creditTotal,
          balance: Math.abs(balance),
          balance_type:
            balance >= 0
              ? account.normal_balance
              : account.normal_balance === "Debit"
                ? "Credit"
                : "Debit",
        };
      });

      // Calculate totals
      const totalDebit = trialBalance.reduce(
        (sum, acc) => sum + acc.debit_total,
        0,
      );
      const totalCredit = trialBalance.reduce(
        (sum, acc) => sum + acc.credit_total,
        0,
      );

      res.json({
        trial_balance: trialBalance,
        summary: {
          total_debits: totalDebit,
          total_credits: totalCredit,
          is_balanced: Math.abs(totalDebit - totalCredit) < 0.01,
        },
        as_of_date: dateFilter,
      });
    } catch (error) {
      console.error("Error generating trial balance:", error);
      res.status(500).json({ error: "Failed to generate trial balance" });
    }
  },
);

// Get Balance Sheet
app.get(
  "/api/admin/ledger/balance-sheet",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { as_of_date } = req.query;
      const dateFilter = as_of_date || new Date().toISOString().split("T")[0];

      // Get all ledger entries up to date
      const { data: entries } = await supabase
        .from("general_ledger")
        .select("*")
        .lte("entry_date", `${dateFilter} 23:59:59`);

      // Get chart of accounts
      const { data: accounts } = await supabase
        .from("chart_of_accounts")
        .select("*");

      // Calculate balances by account type
      const assets = [];
      const liabilities = [];
      const equity = [];

      accounts.forEach((account) => {
        let debitTotal = 0;
        let creditTotal = 0;

        (entries || []).forEach((entry) => {
          if (entry.account_code === account.account_code) {
            debitTotal += entry.debit_amount || 0;
            creditTotal += entry.credit_amount || 0;
          }
        });

        let balance = 0;
        if (account.normal_balance === "Debit") {
          balance = debitTotal - creditTotal;
        } else {
          balance = creditTotal - debitTotal;
        }

        const accountData = {
          account_code: account.account_code,
          account_name: account.account_name,
          balance: Math.abs(balance),
          balance_type:
            balance >= 0
              ? account.normal_balance
              : account.normal_balance === "Debit"
                ? "Credit"
                : "Debit",
        };

        if (account.account_type === "Asset") {
          assets.push(accountData);
        } else if (account.account_type === "Liability") {
          liabilities.push(accountData);
        } else if (account.account_type === "Equity") {
          equity.push(accountData);
        }
      });

      const totalAssets = assets.reduce((sum, a) => sum + a.balance, 0);
      const totalLiabilities = liabilities.reduce(
        (sum, l) => sum + l.balance,
        0,
      );
      const totalEquity = equity.reduce((sum, e) => sum + e.balance, 0);

      res.json({
        assets: { items: assets, total: totalAssets },
        liabilities: { items: liabilities, total: totalLiabilities },
        equity: { items: equity, total: totalEquity },
        total_liabilities_equity: totalLiabilities + totalEquity,
        difference: totalAssets - (totalLiabilities + totalEquity),
        as_of_date: dateFilter,
      });
    } catch (error) {
      console.error("Error generating balance sheet:", error);
      res.status(500).json({ error: "Failed to generate balance sheet" });
    }
  },
);

// Get Income Statement (Profit & Loss)
app.get(
  "/api/admin/ledger/income-statement",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { start_date, end_date } = req.query;

      if (!start_date || !end_date) {
        return res
          .status(400)
          .json({ error: "Start date and end date required" });
      }

      // Get revenue and expense entries
      const { data: entries } = await supabase
        .from("general_ledger")
        .select("*")
        .gte("entry_date", start_date)
        .lte("entry_date", `${end_date} 23:59:59`);

      const { data: revenueAccounts } = await supabase
        .from("chart_of_accounts")
        .select("*")
        .eq("account_type", "Revenue");

      const { data: expenseAccounts } = await supabase
        .from("chart_of_accounts")
        .select("*")
        .eq("account_type", "Expense");

      // Calculate revenue by account
      const revenues = (revenueAccounts || [])
        .map((account) => {
          let creditTotal = 0;
          (entries || []).forEach((entry) => {
            if (entry.account_code === account.account_code) {
              creditTotal += entry.credit_amount || 0;
            }
          });
          return {
            account_code: account.account_code,
            account_name: account.account_name,
            amount: creditTotal,
          };
        })
        .filter((r) => r.amount > 0);

      // Calculate expenses by account
      const expenses = (expenseAccounts || [])
        .map((account) => {
          let debitTotal = 0;
          (entries || []).forEach((entry) => {
            if (entry.account_code === account.account_code) {
              debitTotal += entry.debit_amount || 0;
            }
          });
          return {
            account_code: account.account_code,
            account_name: account.account_name,
            amount: debitTotal,
          };
        })
        .filter((e) => e.amount > 0);

      const totalRevenue = revenues.reduce((sum, r) => sum + r.amount, 0);
      const totalExpenses = expenses.reduce((sum, e) => sum + e.amount, 0);
      const netIncome = totalRevenue - totalExpenses;

      res.json({
        revenues: { items: revenues, total: totalRevenue },
        expenses: { items: expenses, total: totalExpenses },
        net_income: netIncome,
        net_income_type: netIncome >= 0 ? "Profit" : "Loss",
        period: { start_date, end_date },
      });
    } catch (error) {
      console.error("Error generating income statement:", error);
      res.status(500).json({ error: "Failed to generate income statement" });
    }
  },
);

// Get Daily Journal
app.get(
  "/api/admin/ledger/daily-journal",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { date } = req.query;
      const targetDate = date || new Date().toISOString().split("T")[0];

      // Get all entries for the date
      const { data: entries } = await supabase
        .from("general_ledger")
        .select(
          `
                *,
                users!general_ledger_user_id_fkey (id, first_name, last_name, email)
            `,
        )
        .gte("entry_date", `${targetDate} 00:00:00`)
        .lte("entry_date", `${targetDate} 23:59:59`)
        .order("created_at", { ascending: true });

      // Group by hour or batch
      const groupedByHour = {};
      (entries || []).forEach((entry) => {
        const hour = new Date(entry.entry_date).getHours();
        if (!groupedByHour[hour]) {
          groupedByHour[hour] = {
            entries: [],
            total_debit: 0,
            total_credit: 0,
          };
        }
        groupedByHour[hour].entries.push(entry);
        groupedByHour[hour].total_debit += entry.debit_amount || 0;
        groupedByHour[hour].total_credit += entry.credit_amount || 0;
      });

      const totalDebit =
        entries?.reduce((sum, e) => sum + (e.debit_amount || 0), 0) || 0;
      const totalCredit =
        entries?.reduce((sum, e) => sum + (e.credit_amount || 0), 0) || 0;

      res.json({
        date: targetDate,
        entries: entries || [],
        grouped_entries: groupedByHour,
        summary: {
          total_entries: entries?.length || 0,
          total_debit: totalDebit,
          total_credit: totalCredit,
          is_balanced: Math.abs(totalDebit - totalCredit) < 0.01,
        },
      });
    } catch (error) {
      console.error("Error fetching daily journal:", error);
      res.status(500).json({ error: "Failed to fetch daily journal" });
    }
  },
);

// Get Account Statement (Single Account)
app.get(
  "/api/admin/ledger/account-statement/:accountCode",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { accountCode } = req.params;
      const { start_date, end_date, page = 1, limit = 50 } = req.query;
      const offset = (page - 1) * limit;

      let query = supabase
        .from("general_ledger")
        .select("*", { count: "exact" })
        .eq("account_code", accountCode)
        .order("entry_date", { ascending: true });

      if (start_date) {
        query = query.gte("entry_date", start_date);
      }
      if (end_date) {
        query = query.lte("entry_date", `${end_date} 23:59:59`);
      }

      const {
        data: entries,
        error,
        count,
      } = await query.range(offset, offset + limit - 1);

      if (error) throw error;

      // Calculate running balance
      let runningBalance = 0;
      const accountInfo = await supabase
        .from("chart_of_accounts")
        .select("*")
        .eq("account_code", accountCode)
        .single();

      const entriesWithBalance = (entries || []).map((entry) => {
        if (accountInfo?.data?.normal_balance === "Debit") {
          runningBalance +=
            (entry.debit_amount || 0) - (entry.credit_amount || 0);
        } else {
          runningBalance +=
            (entry.credit_amount || 0) - (entry.debit_amount || 0);
        }
        return { ...entry, running_balance: runningBalance };
      });

      res.json({
        account_info: accountInfo.data,
        entries: entriesWithBalance,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: count || 0,
          pages: Math.ceil((count || 0) / limit),
        },
      });
    } catch (error) {
      console.error("Error fetching account statement:", error);
      res.status(500).json({ error: "Failed to fetch account statement" });
    }
  },
);

// Reconcile an account
app.post(
  "/api/admin/ledger/reconcile/:entryId",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { entryId } = req.params;

      const { error } = await supabase
        .from("general_ledger")
        .update({
          is_reconciled: true,
          reconciled_at: new Date(),
          reconciled_by: req.user.id,
        })
        .eq("id", entryId);

      if (error) throw error;

      res.json({ success: true, message: "Entry reconciled successfully" });
    } catch (error) {
      console.error("Error reconciling entry:", error);
      res.status(500).json({ error: "Failed to reconcile entry" });
    }
  },
);

// Get chart of accounts
app.get(
  "/api/admin/ledger/chart-of-accounts",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { data: accounts, error } = await supabase
        .from("chart_of_accounts")
        .select("*")
        .order("account_code");

      if (error) throw error;
      res.json({ accounts: accounts || [] });
    } catch (error) {
      console.error("Error fetching chart of accounts:", error);
      res.status(500).json({ error: "Failed to fetch chart of accounts" });
    }
  },
);

// Create chart of account
app.post(
  "/api/admin/ledger/chart-of-accounts",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const {
        account_code,
        account_name,
        account_type,
        normal_balance,
        description,
        parent_account_id,
      } = req.body;

      const { data: account, error } = await supabase
        .from("chart_of_accounts")
        .insert({
          account_code,
          account_name,
          account_type,
          normal_balance,
          description,
          parent_account_id,
          is_active: true,
        })
        .select()
        .single();

      if (error) throw error;
      res.status(201).json({ success: true, account });
    } catch (error) {
      console.error("Error creating account:", error);
      res.status(500).json({ error: "Failed to create account" });
    }
  },
);

// Export general ledger as CSV
app.get(
  "/api/admin/ledger/general/export",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { start_date, end_date } = req.query;

      let query = supabase
        .from("general_ledger")
        .select("*")
        .order("entry_date", { ascending: true });

      if (start_date) query = query.gte("entry_date", start_date);
      if (end_date) query = query.lte("entry_date", `${end_date} 23:59:59`);

      const { data: entries, error } = await query;

      if (error) throw error;

      // Create CSV
      const headers = [
        "Entry ID",
        "Date",
        "Account Code",
        "Account Name",
        "Description",
        "Reference",
        "Debit",
        "Credit",
        "User ID",
        "Reconciled",
      ];
      const csvRows = [headers.join(",")];

      entries.forEach((entry) => {
        const row = [
          `"${entry.entry_id || ""}"`,
          `"${entry.entry_date}"`,
          `"${entry.account_code || ""}"`,
          `"${entry.account_name || ""}"`,
          `"${(entry.description || "").replace(/"/g, '""')}"`,
          `"${entry.reference || ""}"`,
          entry.debit_amount || 0,
          entry.credit_amount || 0,
          `"${entry.user_id || ""}"`,
          entry.is_reconciled ? "Yes" : "No",
        ];
        csvRows.push(row.join(","));
      });

      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=general_ledger_${new Date().toISOString().split("T")[0]}.csv`,
      );
      res.send(csvRows.join("\n"));
    } catch (error) {
      console.error("Export error:", error);
      res.status(500).json({ error: "Export failed" });
    }
  },
);

// ==================== ADMIN HARVEST PLAN ROUTES ====================

// Get all harvest plans (admin)
app.get(
  "/api/admin/harvest-plans",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { page = 1, limit = 20 } = req.query;
      const offset = (page - 1) * limit;

      const {
        data: plans,
        error,
        count,
      } = await supabase
        .from("harvest_plans")
        .select("*", { count: "exact" })
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) throw error;

      res.json({
        plans: plans || [],
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: count || 0,
          pages: Math.ceil((count || 0) / limit),
        },
      });
    } catch (error) {
      console.error("Admin harvest plans error:", error);
      res.status(500).json({ error: "Failed to fetch harvest plans" });
    }
  },
);

// Create harvest plan (admin)
app.post(
  "/api/admin/harvest-plans",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { name, description, daily_amount, duration_days, reward_items } =
        req.body;
      const total_amount = daily_amount * duration_days;

      const { data: plan, error } = await supabase
        .from("harvest_plans")
        .insert({
          name,
          description,
          daily_amount,
          duration_days,
          total_amount,
          reward_items: JSON.stringify(reward_items || []),
          created_by: req.user.id,
        })
        .select()
        .single();

      if (error) throw error;

      res.status(201).json({ success: true, plan });
    } catch (error) {
      console.error("Create harvest plan error:", error);
      res.status(500).json({ error: "Failed to create harvest plan" });
    }
  },
);

// Update harvest plan (admin)
app.put(
  "/api/admin/harvest-plans/:id",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;
      const {
        name,
        description,
        daily_amount,
        duration_days,
        reward_items,
        is_active,
      } = req.body;
      const total_amount = daily_amount * duration_days;

      const { data: plan, error } = await supabase
        .from("harvest_plans")
        .update({
          name,
          description,
          daily_amount,
          duration_days,
          total_amount,
          reward_items: JSON.stringify(reward_items || []),
          is_active,
          updated_at: new Date(),
        })
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;

      res.json({ success: true, plan });
    } catch (error) {
      console.error("Update harvest plan error:", error);
      res.status(500).json({ error: "Failed to update harvest plan" });
    }
  },
);

// Toggle harvest plan status (admin)
app.post(
  "/api/admin/harvest-plans/:id/toggle",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { is_active } = req.body;

      const { error } = await supabase
        .from("harvest_plans")
        .update({ is_active, updated_at: new Date() })
        .eq("id", id);

      if (error) throw error;

      res.json({ success: true });
    } catch (error) {
      console.error("Toggle harvest plan error:", error);
      res.status(500).json({ error: "Failed to toggle harvest plan" });
    }
  },
);

// Delete harvest plan (admin)
app.delete(
  "/api/admin/harvest-plans/:id",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;

      const { error } = await supabase
        .from("harvest_plans")
        .delete()
        .eq("id", id);

      if (error) throw error;

      res.json({ success: true });
    } catch (error) {
      console.error("Delete harvest plan error:", error);
      res.status(500).json({ error: "Failed to delete harvest plan" });
    }
  },
);

// Get user enrollments (admin)
app.get(
  "/api/admin/users/:userId/enrollments",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { userId } = req.params;

      const [harvest, fixed, savebox, target] = await Promise.all([
        supabase
          .from("user_harvest_enrollments")
          .select("*, harvest_plans(name)")
          .eq("user_id", userId),
        supabase.from("fixed_savings").select("*").eq("user_id", userId),
        supabase.from("savebox_savings").select("*").eq("user_id", userId),
        supabase.from("target_savings").select("*").eq("user_id", userId),
      ]);

      res.json({
        harvest: harvest.data || [],
        fixed: fixed.data || [],
        savebox: savebox.data || [],
        target: target.data || [],
      });
    } catch (error) {
      console.error("Error fetching enrollments:", error);
      res.status(500).json({ error: "Failed to fetch enrollments" });
    }
  },
);

// ==================== ADMIN RESET USER PASSWORD ====================

// Helper: generate random password (e.g., 12 characters)
function generateRandomPassword() {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";
  let password = "";
  for (let i = 0; i < 12; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

app.post(
  "/api/admin/users/:userId/reset-password",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    const { userId } = req.params;

    // Generate temporary password
    const tempPassword = generateRandomPassword();
    const hashedPassword = await bcrypt.hash(tempPassword, 10);

    // Update user
    const { error } = await supabase
      .from("users")
      .update({ password_hash: hashedPassword })
      .eq("id", userId);

    if (error) {
      console.error("Admin reset password error:", error);
      return res.status(500).json({ error: "Failed to reset password" });
    }

    // Get user email
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("email")
      .eq("id", userId)
      .single();

    if (user && !userError) {
      // Send email with new password
      try {
        await transporter.sendMail({
          from: process.env.SMTP_FROM,
          to: user.email,
          subject: "Your password has been reset",
          html: `
                    <h2>Password Reset by Administrator</h2>
                    <p>Your password has been reset. Your new temporary password is:</p>
                    <h3 style="font-size: 24px;">${tempPassword}</h3>
                    <p>Please log in and change your password immediately.</p>
                `,
        });
      } catch (err) {
        console.error("Admin reset email error:", err);
      }
    }

    // Log admin action
    await supabase.from("admin_actions").insert({
      admin_id: req.user.id,
      action_type: "reset_password",
      target_user_id: userId,
      details: { generated_by_admin: true },
    });

    res.json({
      message: "Password reset successful. User has been notified via email.",
    });
  },
);

// Check if user has transfer PIN
app.get("/api/user/has-pin", authenticate, async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from("users")
      .select("transfer_pin, transfer_pin_set_at")
      .eq("id", req.user.id)
      .single();

    if (error) throw error;

    res.json({
      has_pin: !!(user.transfer_pin && user.transfer_pin !== null),
      pin_set_at: user.transfer_pin_set_at,
    });
  } catch (error) {
    console.error("Check PIN error:", error);
    res.status(500).json({ error: "Failed to check PIN status" });
  }
});

// Set/Update transfer PIN
app.post("/api/user/set-transfer-pin", authenticate, async (req, res) => {
  try {
    const { pin } = req.body;

    if (!pin || pin.length !== 4 || !/^\d{4}$/.test(pin)) {
      return res.status(400).json({ error: "PIN must be exactly 4 digits" });
    }

    // Hash the PIN before storing
    const hashedPin = await bcrypt.hash(pin, 10);

    const { error } = await supabase
      .from("users")
      .update({
        transfer_pin: hashedPin,
        transfer_pin_set_at: new Date(),
        pin_attempts: 0,
        last_pin_attempt: null,
      })
      .eq("id", req.user.id);

    if (error) throw error;

    res.json({ success: true, message: "Transfer PIN set successfully" });
  } catch (error) {
    console.error("Set PIN error:", error);
    res.status(500).json({ error: "Failed to set transfer PIN" });
  }
});

// Verify transfer PIN
app.post("/api/user/verify-transfer-pin", authenticate, async (req, res) => {
  try {
    const { pin } = req.body;

    if (!pin || pin.length !== 4) {
      return res
        .status(400)
        .json({ valid: false, error: "Invalid PIN format" });
    }

    const { data: user, error } = await supabase
      .from("users")
      .select("transfer_pin, pin_attempts, last_pin_attempt")
      .eq("id", req.user.id)
      .single();

    if (error) throw error;

    if (!user.transfer_pin) {
      return res.json({ valid: false, needs_setup: true });
    }

    // Check if account is already frozen due to PIN attempts
    if (user.pin_attempts >= 4) {
      return res.status(403).json({
        valid: false,
        frozen: true,
        error: "Too many incorrect PIN attempts. Account frozen.",
      });
    }

    const isValid = await bcrypt.compare(pin, user.transfer_pin);

    if (isValid) {
      // Reset attempts on successful verification
      await supabase
        .from("users")
        .update({ pin_attempts: 0, last_pin_attempt: null })
        .eq("id", req.user.id);

      res.json({ valid: true });
    } else {
      // Increment attempts
      const newAttempts = (user.pin_attempts || 0) + 1;
      const updates = {
        pin_attempts: newAttempts,
        last_pin_attempt: new Date(),
      };

      if (newAttempts >= 4) {
        // Freeze account after 4 failed attempts
        updates.is_frozen = true;
        updates.freeze_reason =
          "Too many incorrect PIN attempts - Contact support to unfreeze";
        updates.unfreeze_method = "support";
      }

      await supabase.from("users").update(updates).eq("id", req.user.id);

      res.json({
        valid: false,
        attempts_remaining: 4 - newAttempts,
        frozen: newAttempts >= 4,
      });
    }
  } catch (error) {
    console.error("Verify PIN error:", error);
    res.status(500).json({ error: "PIN verification failed" });
  }
});

// Freeze account due to PIN attempts
app.post(
  "/api/user/freeze-due-to-pin-attempts",
  authenticate,
  async (req, res) => {
    try {
      const { error } = await supabase
        .from("users")
        .update({
          is_frozen: true,
          freeze_reason: "Too many incorrect PIN attempts - Contact support",
          unfreeze_method: "support",
        })
        .eq("id", req.user.id);

      if (error) throw error;

      res.json({ success: true });
    } catch (error) {
      console.error("Freeze error:", error);
      res.status(500).json({ error: "Failed to freeze account" });
    }
  },
);

// Get account limits
app.get("/api/user/account-limits", authenticate, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get user's account
    const { data: account } = await supabase
      .from("accounts")
      .select("*")
      .eq("user_id", userId)
      .eq("account_type", "checking")
      .single();

    // Get today's transactions sum
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const { data: todayTxs } = await supabase
      .from("transactions")
      .select("amount")
      .eq("from_user_id", userId)
      .eq("status", "completed")
      .gte("created_at", today.toISOString());

    const dailyUsed = todayTxs?.reduce((sum, t) => sum + t.amount, 0) || 0;

    // Get this week's transactions sum
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    weekStart.setHours(0, 0, 0, 0);
    const { data: weekTxs } = await supabase
      .from("transactions")
      .select("amount")
      .eq("from_user_id", userId)
      .eq("status", "completed")
      .gte("created_at", weekStart.toISOString());

    const weeklyUsed = weekTxs?.reduce((sum, t) => sum + t.amount, 0) || 0;

    // Get this month's transactions sum
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const { data: monthTxs } = await supabase
      .from("transactions")
      .select("amount")
      .eq("from_user_id", userId)
      .eq("status", "completed")
      .gte("created_at", monthStart.toISOString());

    const monthlyUsed = monthTxs?.reduce((sum, t) => sum + t.amount, 0) || 0;

    res.json({
      daily_limit: 1000000, // ₦1,000,000 (was $1,000)
      weekly_limit: 5000000, // ₦5,000,000 (was $5,000)
      monthly_limit: 20000000, // ₦20,000,000 (was $20,000)
      single_transaction_limit: 1000000, // ₦1,000,000
      daily_used: dailyUsed,
      weekly_used: weeklyUsed,
      monthly_used: monthlyUsed,
    });
  } catch (error) {
    console.error("Limits error:", error);
    res.status(500).json({ error: "Failed to fetch limits" });
  }
});

// Export transactions as CSV
app.get("/api/user/transactions/export", authenticate, async (req, res) => {
  try {
    const { data: accounts } = await supabase
      .from("accounts")
      .select("id")
      .eq("user_id", req.user.id);

    const accountIds = accounts.map((a) => a.id);

    const { data: transactions } = await supabase
      .from("transactions")
      .select("*")
      .or(
        `from_account_id.in.(${accountIds.join(",")}),to_account_id.in.(${accountIds.join(",")})`,
      )
      .order("created_at", { ascending: false });

    let csv = "Date,Description,Type,Amount (NGN),Status\n";

    transactions.forEach((t) => {
      const isCredit = t.to_user_id === req.user.id;
      const ngnAmount = t.amount * 1500; // Convert to NGN
      csv += `${t.created_at},${t.description || t.transaction_type},${isCredit ? "Credit" : "Debit"},${ngnAmount.toFixed(2)},${t.status}\n`;
    });

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=transactions_${new Date().toISOString().split("T")[0]}.csv`,
    );
    res.send(csv);
  } catch (error) {
    console.error("Export error:", error);
    res.status(500).json({ error: "Export failed" });
  }
});

// ==================== ADMIN SAVINGS MANAGEMENT ====================

// Get all active savings plans (admin)
app.get(
  "/api/admin/savings/all",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { type, status, page = 1, limit = 50 } = req.query;
      const offset = (page - 1) * limit;

      let results = {};

      if (!type || type === "harvest") {
        let query = supabase.from("user_harvest_enrollments").select(`
                    *,
                    users!inner(id, email, first_name, last_name, phone),
                    harvest_plans!inner(name, daily_amount, duration_days)
                `);
        if (status) query = query.eq("status", status);
        const { data, count } = await query.range(offset, offset + limit - 1);
        results.harvest = { data: data || [], total: count || 0 };
      }

      if (!type || type === "fixed") {
        let query = supabase
          .from("fixed_savings")
          .select("*, users!inner(id, email, first_name, last_name, phone)");
        if (status) query = query.eq("status", status);
        const { data, count } = await query.range(offset, offset + limit - 1);
        results.fixed = { data: data || [], total: count || 0 };
      }

      if (!type || type === "savebox") {
        let query = supabase
          .from("savebox_savings")
          .select("*, users!inner(id, email, first_name, last_name, phone)");
        if (status) query = query.eq("status", status);
        const { data, count } = await query.range(offset, offset + limit - 1);
        results.savebox = { data: data || [], total: count || 0 };
      }

      if (!type || type === "target") {
        let query = supabase
          .from("target_savings")
          .select("*, users!inner(id, email, first_name, last_name, phone)");
        if (status) query = query.eq("status", status);
        const { data, count } = await query.range(offset, offset + limit - 1);
        results.target = { data: data || [], total: count || 0 };
      }

      if (!type || type === "spare_change") {
        let query = supabase
          .from("spare_change_savings")
          .select("*, users!inner(id, email, first_name, last_name, phone)");
        if (status) query = query.eq("status", status);
        const { data, count } = await query.range(offset, offset + limit - 1);
        results.spare_change = { data: data || [], total: count || 0 };
      }

      res.json({
        success: true,
        data: results,
        pagination: { page, limit },
      });
    } catch (error) {
      console.error("Admin savings fetch error:", error);
      res.status(500).json({ error: "Failed to fetch savings data" });
    }
  },
);

// Send notification to all users with active savings (admin)
app.post(
  "/api/admin/savings/notify",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    const { savings_type, message, subject } = req.body;

    try {
      let users = [];

      if (!savings_type || savings_type === "harvest") {
        const { data } = await supabase
          .from("user_harvest_enrollments")
          .select("user_id, users(email, first_name, last_name)")
          .eq("status", "active");
        users.push(...(data || []));
      }

      if (!savings_type || savings_type === "fixed") {
        const { data } = await supabase
          .from("fixed_savings")
          .select("user_id, users(email, first_name, last_name)")
          .in("status", ["active", "matured"]);
        users.push(...(data || []));
      }

      if (!savings_type || savings_type === "savebox") {
        const { data } = await supabase
          .from("savebox_savings")
          .select("user_id, users(email, first_name, last_name)")
          .eq("status", "active");
        users.push(...(data || []));
      }

      if (!savings_type || savings_type === "target") {
        const { data } = await supabase
          .from("target_savings")
          .select("user_id, users(email, first_name, last_name)")
          .eq("status", "active");
        users.push(...(data || []));
      }

      // Remove duplicates
      const uniqueUsers = [
        ...new Map(users.map((u) => [u.user_id, u])).values(),
      ];

      // Send notifications
      for (const user of uniqueUsers) {
        await supabase.from("notifications").insert({
          user_id: user.user_id,
          title: subject || "Savings Plan Update",
          message: message,
          type: "info",
        });

        // Send email
        if (user.users?.email) {
          await transporter.sendMail({
            from: process.env.SMTP_FROM,
            to: user.users.email,
            subject: subject || "Savings Plan Update",
            html: `<h2>Savings Plan Update</h2><p>Dear ${user.users.first_name},</p><p>${message}</p><p>Thank you for banking with us.</p>`,
          });
        }
      }

      res.json({
        success: true,
        message: `Notification sent to ${uniqueUsers.length} users`,
      });
    } catch (error) {
      console.error("Admin notify error:", error);
      res.status(500).json({ error: "Failed to send notifications" });
    }
  },
);

// Get savings statistics (admin)
app.get(
  "/api/admin/savings/stats",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const [harvestStats, fixedStats, saveboxStats, targetStats, spareStats] =
        await Promise.all([
          supabase
            .from("user_harvest_enrollments")
            .select("total_saved, days_completed, status", { count: "exact" }),
          supabase
            .from("fixed_savings")
            .select("current_saved, status", { count: "exact" }),
          supabase
            .from("savebox_savings")
            .select("current_saved, status", { count: "exact" }),
          supabase
            .from("target_savings")
            .select("current_saved, target_amount, status", { count: "exact" }),
          supabase
            .from("spare_change_savings")
            .select("current_saved, total_saved, status", { count: "exact" }),
        ]);

      const totalSaved =
        (harvestStats.data?.reduce((s, h) => s + (h.total_saved || 0), 0) ||
          0) +
        (fixedStats.data?.reduce((s, f) => s + (f.current_saved || 0), 0) ||
          0) +
        (saveboxStats.data?.reduce((s, sb) => s + (sb.current_saved || 0), 0) ||
          0) +
        (targetStats.data?.reduce((s, t) => s + (t.current_saved || 0), 0) ||
          0) +
        (spareStats.data?.reduce((s, sp) => s + (sp.current_saved || 0), 0) ||
          0);

      res.json({
        total_saved: totalSaved,
        counts: {
          harvest: {
            active:
              harvestStats.data?.filter((h) => h.status === "active").length ||
              0,
            total: harvestStats.count || 0,
          },
          fixed: {
            active:
              fixedStats.data?.filter((f) => f.status === "active").length || 0,
            total: fixedStats.count || 0,
          },
          savebox: {
            active:
              saveboxStats.data?.filter((s) => s.status === "active").length ||
              0,
            total: saveboxStats.count || 0,
          },
          target: {
            active:
              targetStats.data?.filter((t) => t.status === "active").length ||
              0,
            total: targetStats.count || 0,
          },
          spare_change: {
            active:
              spareStats.data?.filter((s) => s.status === "active").length || 0,
            total: spareStats.count || 0,
          },
        },
      });
    } catch (error) {
      console.error("Savings stats error:", error);
      res.status(500).json({ error: "Failed to fetch savings stats" });
    }
  },
);

// ==================== ADMIN HARVEST ENROLLMENTS ROUTES ====================

// Get all harvest enrollments (admin)
app.get(
  "/api/admin/harvest-enrollments",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const {
        page = 1,
        limit = 20,
        search,
        status,
        auto_save,
        plan_id,
      } = req.query;
      const offset = (page - 1) * limit;

      let query = supabase.from("user_harvest_enrollments").select(
        `
                *,
                users!inner(id, first_name, last_name, email, phone),
                harvest_plans!inner(id, name, daily_amount, duration_days, reward_items)
            `,
        { count: "exact" },
      );

      if (search) {
        query = query.or(
          `users.first_name.ilike.%${search}%,users.last_name.ilike.%${search}%,users.email.ilike.%${search}%`,
        );
      }
      if (status && status !== "all") {
        query = query.eq("status", status);
      }
      if (auto_save && auto_save !== "all") {
        query = query.eq("auto_save", auto_save === "true");
      }
      if (plan_id && plan_id !== "all") {
        query = query.eq("plan_id", plan_id);
      }

      const {
        data: enrollments,
        error,
        count,
      } = await query
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) throw error;

      // Calculate stats
      const { data: allEnrollments } = await supabase
        .from("user_harvest_enrollments")
        .select(
          "total_saved, days_completed, auto_save, harvest_plans(duration_days)",
        )
        .eq("status", "active");

      const totalSaved =
        allEnrollments?.reduce((sum, e) => sum + (e.total_saved || 0), 0) || 0;
      const totalDaysCompleted =
        allEnrollments?.reduce((sum, e) => sum + (e.days_completed || 0), 0) ||
        0;
      const totalPossibleDays =
        allEnrollments?.reduce(
          (sum, e) => sum + (e.harvest_plans?.duration_days || 0),
          0,
        ) || 0;
      const avgCompletion =
        totalPossibleDays > 0
          ? Math.round((totalDaysCompleted / totalPossibleDays) * 100)
          : 0;
      const autoSaveOn =
        allEnrollments?.filter((e) => e.auto_save === true).length || 0;

      res.json({
        enrollments: enrollments || [],
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: count || 0,
          pages: Math.ceil((count || 0) / limit),
        },
        stats: {
          total_enrolled: count || 0,
          total_saved: totalSaved,
          avg_completion: avgCompletion,
          auto_save_on: autoSaveOn,
        },
      });
    } catch (error) {
      console.error("Admin harvest enrollments error:", error);
      res.status(500).json({ error: "Failed to fetch enrollments" });
    }
  },
);

// Get single enrollment details
app.get(
  "/api/admin/harvest-enrollments/:id",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;

      const { data: enrollment, error } = await supabase
        .from("user_harvest_enrollments")
        .select(
          `
                *,
                users!inner(id, first_name, last_name, email, phone),
                harvest_plans!inner(id, name, daily_amount, duration_days, reward_items)
            `,
        )
        .eq("id", id)
        .single();

      if (error) throw error;

      res.json(enrollment);
    } catch (error) {
      console.error("Error fetching enrollment:", error);
      res.status(500).json({ error: "Failed to fetch enrollment details" });
    }
  },
);

// Toggle user auto-save
app.put(
  "/api/admin/harvest-enrollments/:id/toggle-auto",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { auto_save } = req.body;

      const { error } = await supabase
        .from("user_harvest_enrollments")
        .update({ auto_save: auto_save, updated_at: new Date() })
        .eq("id", id);

      if (error) throw error;

      res.json({
        success: true,
        message: `Auto-save ${auto_save ? "enabled" : "disabled"}`,
      });
    } catch (error) {
      console.error("Toggle auto-save error:", error);
      res.status(500).json({ error: "Failed to toggle auto-save" });
    }
  },
);

// Send bulk notification to harvest users
app.post(
  "/api/admin/harvest/send-notification",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const {
        user_filter,
        user_ids,
        subject,
        message,
        send_email,
        notification_type,
      } = req.body;

      let targetUsers = [];

      if (user_filter === "specific" && user_ids && user_ids.length > 0) {
        const { data: users } = await supabase
          .from("users")
          .select("id, email, first_name, last_name")
          .in("id", user_ids);
        targetUsers = users || [];
      } else {
        let query = supabase
          .from("user_harvest_enrollments")
          .select(
            "user_id, users!inner(id, email, first_name, last_name), harvest_plans!inner(name), days_completed, total_saved",
          );

        if (user_filter === "behind") {
          // Users with less than 50% completion relative to expected progress
          query = query.lt(
            "days_completed",
            supabase.raw("harvest_plans.duration_days * 0.5"),
          );
        } else if (user_filter === "auto_off") {
          query = query.eq("auto_save", false);
        }

        const { data: enrollments } = await query;
        targetUsers = [
          ...new Map(
            enrollments?.map((e) => [e.user_id, e.users]).filter(Boolean),
          ),
        ].map(([_, user]) => user);
      }

      let sentCount = 0;

      for (const user of targetUsers) {
        // Create in-app notification
        await supabase.from("notifications").insert({
          user_id: user.id,
          title: subject,
          message: message,
          type: notification_type || "info",
          created_at: new Date(),
        });

        if (send_email && user.email) {
          try {
            await transporter.sendMail({
              from: process.env.SMTP_FROM,
              to: user.email,
              subject: subject,
              html: `<h2>${subject}</h2><p>Dear ${user.first_name || "User"},</p><p>${message.replace(/\n/g, "<br>")}</p><p>Thank you for banking with us.</p>`,
            });
          } catch (emailErr) {
            console.error("Email error for", user.email, emailErr);
          }
        }

        sentCount++;
      }

      // Log admin action
      await supabase.from("admin_actions").insert({
        admin_id: req.user.id,
        action_type: "harvest_bulk_notification",
        details: {
          user_filter,
          sent_count: sentCount,
          subject,
          notification_type,
        },
      });

      res.json({
        success: true,
        message: `Notification sent to ${sentCount} users`,
      });
    } catch (error) {
      console.error("Send notification error:", error);
      res.status(500).json({ error: "Failed to send notifications" });
    }
  },
);

// ADMIN: Get harvest plan withdrawal requests
app.get(
  "/api/admin/harvest-withdrawal-requests",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      console.log("Fetching harvest withdrawal requests...");

      const { data: requests, error } = await supabase
        .from("harvest_withdrawal_requests")
        .select(
          `
          *,
          users:user_id (
            id, 
            email, 
            first_name, 
            last_name, 
            phone
          ),
          user_harvest_enrollments:enrollment_id (
            id, 
            total_saved, 
            days_completed,
            harvest_plans:plan_id (
              name, 
              daily_amount, 
              duration_days,
              reward_items
            )
          )
        `,
        )
        .order("created_at", { ascending: false });

      if (error) {
        console.error("Supabase error fetching withdrawal requests:", error);
        return res.status(500).json({ error: error.message });
      }

      console.log(`Found ${requests?.length || 0} withdrawal requests`);
      res.json({ requests: requests || [] });
    } catch (error) {
      console.error("Error fetching withdrawal requests:", error);
      res.status(500).json({ error: error.message });
    }
  },
);

// USER: Request harvest plan withdrawal (requires admin approval)
app.post(
  "/api/user/savings/harvest/:id/request-withdrawal",
  authenticate,
  async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;

    try {
      console.log(
        `User ${req.user.id} requesting withdrawal for harvest plan ${id}`,
      );

      // Get harvest enrollment
      const { data: enrollment, error: hError } = await supabase
        .from("user_harvest_enrollments")
        .select(
          `
          *,
          harvest_plans!inner(name, daily_amount, duration_days)
        `,
        )
        .eq("id", id)
        .eq("user_id", req.user.id)
        .single();

      if (hError || !enrollment) {
        console.error("Enrollment not found:", hError);
        return res.status(404).json({ error: "Harvest plan not found" });
      }

      // Check if already completed or cancelled
      if (enrollment.status !== "active") {
        return res
          .status(400)
          .json({ error: "Cannot request withdrawal for this plan" });
      }

      // Check if withdrawal request already exists
      const { data: existing, error: existError } = await supabase
        .from("harvest_withdrawal_requests")
        .select("id, status")
        .eq("enrollment_id", id)
        .in("status", ["pending", "approved"])
        .maybeSingle();

      if (existing) {
        if (existing.status === "pending") {
          return res
            .status(400)
            .json({ error: "Withdrawal request already pending" });
        }
        if (existing.status === "approved") {
          return res
            .status(400)
            .json({ error: "Withdrawal already processed for this plan" });
        }
      }

      // Create withdrawal request
      const { data: request, error } = await supabase
        .from("harvest_withdrawal_requests")
        .insert({
          user_id: req.user.id,
          enrollment_id: id,
          amount: enrollment.total_saved || 0,
          reason: reason || "No reason provided",
          status: "pending",
          created_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (error) {
        console.error("Error creating withdrawal request:", error);
        return res
          .status(500)
          .json({ error: "Failed to create withdrawal request" });
      }

      // Create notification for user
      await supabase.from("notifications").insert({
        user_id: req.user.id,
        title: "Withdrawal Request Submitted",
        message: `Your Harvest Plan withdrawal request for ₦${(enrollment.total_saved || 0).toLocaleString()} has been submitted for admin approval.`,
        type: "info",
        created_at: new Date().toISOString(),
      });

      console.log(`Withdrawal request created: ${request.id}`);
      res.json({
        success: true,
        message:
          "Withdrawal request submitted. Admin will review your request.",
        request,
      });
    } catch (error) {
      console.error("Withdrawal request error:", error);
      res.status(500).json({ error: error.message });
    }
  },
);

// ADMIN: Approve harvest withdrawal
app.post(
  "/api/admin/harvest-withdrawal/:requestId/approve",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    const { requestId } = req.params;

    try {
      console.log(
        `Admin ${req.user.id} approving withdrawal request ${requestId}`,
      );

      // Get the request with all related data
      const { data: request, error: fetchError } = await supabase
        .from("harvest_withdrawal_requests")
        .select(
          `
          *,
          users:user_id (
            id, 
            email, 
            first_name, 
            last_name
          ),
          user_harvest_enrollments:enrollment_id (
            id, 
            total_saved,
            user_id,
            plan_id,
            status
          )
        `,
        )
        .eq("id", requestId)
        .single();

      if (fetchError || !request) {
        console.error("Request not found:", fetchError);
        return res.status(404).json({ error: "Request not found" });
      }

      if (request.status !== "pending") {
        return res.status(400).json({ error: "Request already processed" });
      }

      // Get user's primary account
      const { data: account, error: accError } = await supabase
        .from("accounts")
        .select("*")
        .eq("user_id", request.user_id)
        .eq("account_type", "checking")
        .single();

      if (accError || !account) {
        console.error("User account not found:", accError);
        return res.status(404).json({ error: "User account not found" });
      }

      // Refund the amount to user's account
      const newBalance = (account.balance || 0) + (request.amount || 0);
      const newAvailable =
        (account.available_balance || 0) + (request.amount || 0);

      const { error: updateBalanceError } = await supabase
        .from("accounts")
        .update({
          balance: newBalance,
          available_balance: newAvailable,
          updated_at: new Date().toISOString(),
        })
        .eq("id", account.id);

      if (updateBalanceError) {
        console.error("Balance update error:", updateBalanceError);
        return res.status(500).json({ error: "Failed to update balance" });
      }

      // Update harvest enrollment status to "withdrawn"
      const { error: updateEnrollmentError } = await supabase
        .from("user_harvest_enrollments")
        .update({
          status: "withdrawn",
          auto_save: false,
          updated_at: new Date().toISOString(),
        })
        .eq("id", request.enrollment_id);

      if (updateEnrollmentError) {
        console.error("Enrollment update error:", updateEnrollmentError);
      }

      // Update request status
      const { error: updateRequestError } = await supabase
        .from("harvest_withdrawal_requests")
        .update({
          status: "approved",
          processed_at: new Date().toISOString(),
          processed_by: req.user.id,
          admin_note: `Approved by ${req.user.email}`,
        })
        .eq("id", requestId);

      if (updateRequestError) {
        console.error("Request update error:", updateRequestError);
        return res
          .status(500)
          .json({ error: "Failed to update request status" });
      }

      // Create refund transaction
      const { error: transError } = await supabase.from("transactions").insert({
        to_account_id: account.id,
        to_user_id: request.user_id,
        amount: request.amount,
        description: "Harvest Plan Withdrawal (Admin Approved)",
        transaction_type: "savings_withdrawal",
        status: "completed",
        completed_at: new Date().toISOString(),
        is_admin_adjusted: true,
        admin_note: `Harvest withdrawal approved by ${req.user.email}`,
      });

      if (transError) {
        console.error("Transaction creation error:", transError);
      }

      // Send notification to user
      await supabase.from("notifications").insert({
        user_id: request.user_id,
        title: "Withdrawal Request Approved ✅",
        message: `Your Harvest Plan withdrawal of ₦${(request.amount || 0).toLocaleString()} has been approved. Funds have been returned to your account.`,
        type: "success",
        created_at: new Date().toISOString(),
      });

      // Log admin action
      await supabase.from("admin_actions").insert({
        admin_id: req.user.id,
        action_type: "approve_harvest_withdrawal",
        target_user_id: request.user_id,
        details: { request_id: requestId, amount: request.amount },
        created_at: new Date().toISOString(),
      });

      console.log(`Withdrawal ${requestId} approved successfully`);
      res.json({
        success: true,
        message: "Withdrawal approved and funds returned",
      });
    } catch (error) {
      console.error("Approve withdrawal error:", error);
      res.status(500).json({ error: error.message });
    }
  },
);

// ADMIN: Reject harvest withdrawal
app.post(
  "/api/admin/harvest-withdrawal/:requestId/reject",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    const { requestId } = req.params;
    const { reason } = req.body;

    try {
      console.log(
        `Admin ${req.user.id} rejecting withdrawal request ${requestId}`,
      );

      const { data: request, error: fetchError } = await supabase
        .from("harvest_withdrawal_requests")
        .select(
          `
          *,
          users:user_id (
            id, 
            email, 
            first_name, 
            last_name
          )
        `,
        )
        .eq("id", requestId)
        .single();

      if (fetchError || !request) {
        console.error("Request not found:", fetchError);
        return res.status(404).json({ error: "Request not found" });
      }

      if (request.status !== "pending") {
        return res.status(400).json({ error: "Request already processed" });
      }

      // Update request status
      const { error: updateError } = await supabase
        .from("harvest_withdrawal_requests")
        .update({
          status: "rejected",
          processed_at: new Date().toISOString(),
          processed_by: req.user.id,
          admin_note: reason || `Rejected by ${req.user.email}`,
        })
        .eq("id", requestId);

      if (updateError) {
        console.error("Request update error:", updateError);
        return res.status(500).json({ error: "Failed to update request" });
      }

      // Send notification to user
      await supabase.from("notifications").insert({
        user_id: request.user_id,
        title: "Withdrawal Request Rejected ❌",
        message: `Your Harvest Plan withdrawal request was rejected. Reason: ${reason || "Not specified"}. Please continue your savings plan.`,
        type: "error",
        created_at: new Date().toISOString(),
      });

      // Log admin action
      await supabase.from("admin_actions").insert({
        admin_id: req.user.id,
        action_type: "reject_harvest_withdrawal",
        target_user_id: request.user_id,
        details: { request_id: requestId, reason: reason },
        created_at: new Date().toISOString(),
      });

      console.log(`Withdrawal ${requestId} rejected`);
      res.json({ success: true, message: "Withdrawal request rejected" });
    } catch (error) {
      console.error("Reject withdrawal error:", error);
      res.status(500).json({ error: error.message });
    }
  },
);

// ==================== USER ACCOUNT CLOSURE ROUTES ====================

// Check if user is eligible to close account
app.get("/api/user/check-close-eligibility", authenticate, async (req, res) => {
  try {
    // Get user balance
    const { data: accounts, error: accError } = await supabase
      .from("accounts")
      .select("balance")
      .eq("user_id", req.user.id);

    const totalBalance =
      accounts?.reduce((sum, acc) => sum + (acc.balance || 0), 0) || 0;

    // Check for active savings plans
    const [harvest, fixed, savebox, target, spare] = await Promise.all([
      supabase
        .from("user_harvest_enrollments")
        .select("id, status")
        .eq("user_id", req.user.id)
        .eq("status", "active"),
      supabase
        .from("fixed_savings")
        .select("id, status")
        .eq("user_id", req.user.id)
        .in("status", ["active", "matured"]),
      supabase
        .from("savebox_savings")
        .select("id, status")
        .eq("user_id", req.user.id)
        .eq("status", "active"),
      supabase
        .from("target_savings")
        .select("id, status")
        .eq("user_id", req.user.id)
        .eq("status", "active"),
      supabase
        .from("spare_change_savings")
        .select("id, status")
        .eq("user_id", req.user.id)
        .eq("status", "active"),
    ]);

    const activePlans = [];
    const activePlansList = [];

    if (harvest.data?.length > 0) {
      activePlans.push(...harvest.data);
      activePlansList.push("Harvest Plan");
    }
    if (fixed.data?.length > 0) {
      activePlans.push(...fixed.data);
      activePlansList.push("Fixed Savings");
    }
    if (savebox.data?.length > 0) {
      activePlans.push(...savebox.data);
      activePlansList.push("SaveBox");
    }
    if (target.data?.length > 0) {
      activePlans.push(...target.data);
      activePlansList.push("Target Savings");
    }
    if (spare.data?.length > 0) {
      activePlans.push(...spare.data);
      activePlansList.push("Spare Change");
    }

    // Check last transaction date
    const { data: lastTransaction, error: txError } = await supabase
      .from("transactions")
      .select("created_at")
      .or(`from_user_id.eq.${req.user.id},to_user_id.eq.${req.user.id}`)
      .order("created_at", { ascending: false })
      .limit(1);

    let daysSinceLastTx = 999;
    if (lastTransaction && lastTransaction.length > 0) {
      const lastTxDate = new Date(lastTransaction[0].created_at);
      const today = new Date();
      daysSinceLastTx = Math.floor(
        (today - lastTxDate) / (1000 * 60 * 60 * 24),
      );
    }

    const isEligible =
      totalBalance === 0 && activePlans.length === 0 && daysSinceLastTx >= 7;

    res.json({
      eligible: isEligible,
      balance: totalBalance,
      has_active_savings: activePlans.length > 0,
      recent_transaction_days: daysSinceLastTx >= 7 ? 0 : daysSinceLastTx,
      active_plans_list: activePlansList,
    });
  } catch (error) {
    console.error("Close eligibility error:", error);
    res.status(500).json({ error: "Failed to check eligibility" });
  }
});

// Close user account
app.post("/api/user/close-account", authenticate, async (req, res) => {
  try {
    const { reason } = req.body;

    // Verify eligibility again
    const { data: accounts } = await supabase
      .from("accounts")
      .select("balance")
      .eq("user_id", req.user.id);

    const totalBalance =
      accounts?.reduce((sum, acc) => sum + (acc.balance || 0), 0) || 0;

    if (totalBalance > 0) {
      return res.status(400).json({
        error: "Please withdraw all funds before closing your account",
      });
    }

    // Log closed account
    const { error: logError } = await supabase.from("closed_accounts").insert({
      user_id: req.user.id,
      user_email: req.user.email,
      user_name: `${req.user.first_name} ${req.user.last_name}`,
      reason: reason,
      closed_at: new Date(),
      balance_at_close: totalBalance,
    });

    if (logError) console.error("Failed to log closed account:", logError);

    // Delete user data (soft delete - deactivate)
    await supabase
      .from("users")
      .update({
        is_active: false,
        is_frozen: true,
        freeze_reason: "Account closed by user",
        deleted_at: new Date(),
      })
      .eq("id", req.user.id);

    // Clear sensitive data
    await supabase
      .from("users")
      .update({
        password_hash: null,
        transfer_pin: null,
        face_image: null,
      })
      .eq("id", req.user.id);

    res.json({ success: true, message: "Account closed successfully" });
  } catch (error) {
    console.error("Close account error:", error);
    res.status(500).json({ error: "Failed to close account" });
  }
});

// Lock user account (self-lock)
app.post("/api/user/lock-account", authenticate, async (req, res) => {
  try {
    const { reason, unfreeze_method } = req.body;

    await supabase
      .from("users")
      .update({
        is_frozen: true,
        freeze_reason: `User self-locked: ${reason}`,
        unfreeze_method: unfreeze_method || "support",
        updated_at: new Date(),
      })
      .eq("id", req.user.id);

    res.json({ success: true, message: "Account frozen successfully" });
  } catch (error) {
    console.error("Lock account error:", error);
    res.status(500).json({ error: "Failed to freeze account" });
  }
});

// ADMIN: Get all closed accounts
app.get(
  "/api/admin/closed-accounts",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { data: closedAccounts, error } = await supabase
        .from("closed_accounts")
        .select("*")
        .order("closed_at", { ascending: false });

      if (error) throw error;
      res.json({ closed_accounts: closedAccounts || [] });
    } catch (error) {
      console.error("Fetch closed accounts error:", error);
      res.status(500).json({ error: "Failed to fetch closed accounts" });
    }
  },
);

// ADMIN: Delete closed account record
app.delete(
  "/api/admin/closed-accounts/:id",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { error } = await supabase
        .from("closed_accounts")
        .delete()
        .eq("id", id);

      if (error) throw error;
      res.json({ success: true });
    } catch (error) {
      console.error("Delete closed account error:", error);
      res.status(500).json({ error: "Failed to delete record" });
    }
  },
);

// ADMIN: Delete all closed accounts
app.delete(
  "/api/admin/closed-accounts/all",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { error } = await supabase
        .from("closed_accounts")
        .delete()
        .neq("id", "00000000-0000-0000-0000-000000000000");

      if (error) throw error;
      res.json({
        success: true,
        message: "All closed account records deleted",
      });
    } catch (error) {
      console.error("Delete all closed accounts error:", error);
      res.status(500).json({ error: "Failed to delete records" });
    }
  },
);

// ==================== ADMIN ROUTES ================

// Get all external transfers (admin)
app.get(
  "/api/admin/external-transfers",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { page = 1, limit = 20, status, bank } = req.query;
      const offset = (page - 1) * limit;

      let query = supabase
        .from("external_transfers")
        .select(
          `
                *,
                users!external_transfers_user_id_fkey (
                    id,
                    first_name,
                    last_name,
                    email,
                    phone
                ),
                accounts!external_transfers_from_account_id_fkey (
                    id,
                    account_number
                )
            `,
          { count: "exact" },
        )
        .order("created_at", { ascending: false });

      if (status && status !== "all") {
        query = query.eq("status", status);
      }

      if (bank && bank !== "all") {
        query = query.eq("bank_name", bank);
      }

      const {
        data: transfers,
        error,
        count,
      } = await query.range(offset, offset + limit - 1);

      if (error) throw error;

      // Get pending count for badge
      const { count: pendingCount } = await supabase
        .from("external_transfers")
        .select("*", { count: "exact", head: true })
        .eq("status", "pending");

      res.json({
        transfers: transfers || [],
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: count || 0,
          pages: Math.ceil((count || 0) / limit),
        },
        pendingCount: pendingCount || 0,
      });
    } catch (error) {
      console.error("Admin external transfers error:", error);
      res.status(500).json({ error: "Failed to fetch external transfers" });
    }
  },
);

// Approve external transfer (admin)
app.post(
  "/api/admin/external-transfers/:id/approve",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;

      // Get the transfer
      const { data: transfer, error: fetchError } = await supabase
        .from("external_transfers")
        .select("*")
        .eq("id", id)
        .single();

      if (fetchError || !transfer) {
        return res.status(404).json({ error: "Transfer not found" });
      }

      if (transfer.status !== "pending") {
        return res.status(400).json({ error: "Transfer already processed" });
      }

      // Update transfer status to completed
      const { error: updateError } = await supabase
        .from("external_transfers")
        .update({
          status: "completed",
          processed_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          processed_by: req.user.id,
          admin_note: `Approved by ${req.user.email}`,
        })
        .eq("id", id);

      if (updateError) throw updateError;

      // Create notification for user
      await supabase.from("notifications").insert({
        user_id: transfer.user_id,
        title: "External Transfer Approved ✅",
        message: `Your transfer of $${transfer.amount} to ${transfer.bank_name} has been approved and is being processed. Funds will arrive within 2-3 business days.`,
        type: "success",
        created_at: new Date().toISOString(),
      });

      res.json({
        success: true,
        message: "External transfer approved successfully",
      });
    } catch (error) {
      console.error("Approve external transfer error:", error);
      res.status(500).json({ error: "Failed to approve transfer" });
    }
  },
);

// Reject external transfer (admin) - REFUNDS THE USER
app.post(
  "/api/admin/external-transfers/:id/reject",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { reason } = req.body;

      // Get the transfer
      const { data: transfer, error: fetchError } = await supabase
        .from("external_transfers")
        .select("*")
        .eq("id", id)
        .single();

      if (fetchError || !transfer) {
        return res.status(404).json({ error: "Transfer not found" });
      }

      if (transfer.status !== "pending") {
        return res.status(400).json({ error: "Transfer already processed" });
      }

      // REFUND THE USER - Add money back to their account
      const { data: account, error: accountError } = await supabase
        .from("accounts")
        .select("*")
        .eq("id", transfer.from_account_id)
        .single();

      if (!accountError && account) {
        await supabase
          .from("accounts")
          .update({
            balance: account.balance + transfer.amount,
            available_balance: account.available_balance + transfer.amount,
            updated_at: new Date().toISOString(),
          })
          .eq("id", transfer.from_account_id);

        // Create refund transaction record
        await supabase.from("transactions").insert({
          to_account_id: transfer.from_account_id,
          to_user_id: transfer.user_id,
          amount: transfer.amount,
          description: `Refund: External transfer to ${transfer.bank_name} was rejected. Reason: ${reason || "Not specified"}`,
          transaction_type: "refund",
          status: "completed",
          completed_at: new Date().toISOString(),
          is_admin_adjusted: true,
          admin_note: `Rejected by ${req.user.email}. Refunded.`,
        });
      }

      // Update transfer status to rejected
      const { error: updateError } = await supabase
        .from("external_transfers")
        .update({
          status: "rejected",
          processed_at: new Date().toISOString(),
          processed_by: req.user.id,
          admin_note: reason || `Rejected by ${req.user.email}`,
        })
        .eq("id", id);

      if (updateError) throw updateError;

      // Create notification for user about rejection and refund
      await supabase.from("notifications").insert({
        user_id: transfer.user_id,
        title: "External Transfer Rejected ❌",
        message: `Your transfer of $${transfer.amount} to ${transfer.bank_name} was rejected. Reason: ${reason || "Not specified"}. Funds have been refunded to your account.`,
        type: "error",
        created_at: new Date().toISOString(),
      });

      res.json({
        success: true,
        message: "External transfer rejected and funds refunded",
      });
    } catch (error) {
      console.error("Reject external transfer error:", error);
      res.status(500).json({ error: "Failed to reject transfer" });
    }
  },
);

// Get external transfer stats for admin dashboard
app.get(
  "/api/admin/external-transfers/stats",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      // Get counts by status
      const { data: statusCounts } = await supabase
        .from("external_transfers")
        .select("status, count")
        .select("status", { count: "exact", head: false });

      // Get total volume
      const { data: volumeData } = await supabase
        .from("external_transfers")
        .select("amount")
        .eq("status", "completed");

      const totalVolume =
        volumeData?.reduce((sum, t) => sum + t.amount, 0) || 0;

      // Get pending count
      const { count: pendingCount } = await supabase
        .from("external_transfers")
        .select("*", { count: "exact", head: true })
        .eq("status", "pending");

      res.json({
        pending: pendingCount || 0,
        completed: volumeData?.length || 0,
        totalVolume: totalVolume,
        averageAmount: volumeData?.length ? totalVolume / volumeData.length : 0,
      });
    } catch (error) {
      console.error("Error fetching external transfer stats:", error);
      res.status(500).json({ error: "Failed to fetch stats" });
    }
  },
);

// ==================== ADMIN ROUTES ================

// GET all add money requests (admin) - Modified to show full card details
app.get(
  "/api/admin/add-money-requests",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { page = 1, status = "pending", limit = 20 } = req.query;
      const offset = (page - 1) * limit;

      // Build the query - get ALL card details
      let query = supabase.from("add_money_requests").select(
        `
                *,
                user:users!add_money_requests_user_id_fkey (
                    id,
                    first_name,
                    last_name,
                    email,
                    phone
                )
            `,
        { count: "exact" },
      );

      // Apply status filter if not 'all'
      if (status && status !== "all" && status !== "") {
        query = query.eq("status", status);
      }

      // Order by newest first
      query = query.order("created_at", { ascending: false });

      // Apply pagination
      query = query.range(offset, offset + limit - 1);

      const { data: requests, error, count } = await query;

      if (error) {
        console.error("Supabase error:", error);
        throw error;
      }

      // Get pending count for badge
      const { count: pendingCount, error: pendingError } = await supabase
        .from("add_money_requests")
        .select("*", { count: "exact", head: true })
        .eq("status", "pending");

      if (pendingError) {
        console.error("Pending count error:", pendingError);
      }

      res.json({
        requests: requests || [],
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: count || 0,
          pages: Math.ceil((count || 0) / limit),
        },
        pendingCount: pendingCount || 0,
      });
    } catch (error) {
      console.error("Admin add money requests error:", error);
      res.status(500).json({
        error: "Failed to load add money requests",
        details: error.message,
      });
    }
  },
);

// POST approve add money request
app.post(
  "/api/admin/add-money-requests/:id/approve",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    const { id } = req.params;

    try {
      // First, get the request
      const { data: request, error: fetchError } = await supabase
        .from("add_money_requests")
        .select("*")
        .eq("id", id)
        .single();

      if (fetchError || !request) {
        return res.status(404).json({ error: "Request not found" });
      }

      if (request.status !== "pending") {
        return res.status(400).json({ error: "Request already processed" });
      }

      // Update request status
      const { error: updateError } = await supabase
        .from("add_money_requests")
        .update({
          status: "approved",
          processed_at: new Date().toISOString(),
          processed_by: req.user.id,
          admin_note: `Approved by ${req.user.email}`,
        })
        .eq("id", id);

      if (updateError) throw updateError;

      // Find user's primary account
      const { data: accounts, error: accountError } = await supabase
        .from("accounts")
        .select("*")
        .eq("user_id", request.user_id)
        .order("created_at", { ascending: true });

      if (accountError) throw accountError;

      if (accounts && accounts.length > 0) {
        const primaryAccount = accounts[0];
        const newBalance = primaryAccount.balance + request.amount;

        // Update account balance
        const { error: balanceError } = await supabase
          .from("accounts")
          .update({
            balance: newBalance,
            available_balance: newBalance,
            updated_at: new Date().toISOString(),
          })
          .eq("id", primaryAccount.id);

        if (balanceError) throw balanceError;

        // Create transaction record
        const { error: transError } = await supabase
          .from("transactions")
          .insert({
            to_account_id: primaryAccount.id,
            to_user_id: request.user_id,
            amount: request.amount,
            description: `Add money via card ending in ${request.card_number.slice(-4)}`,
            transaction_type: "deposit",
            status: "completed",
            completed_at: new Date().toISOString(),
            is_admin_adjusted: true,
            admin_note: `Approved by admin ${req.user.email}`,
          });

        if (transError)
          console.error("Transaction creation error:", transError);
      }

      // Send notification to user
      await supabase.from("notifications").insert({
        user_id: request.user_id,
        title: "Add Money Request Approved ✅",
        message: `Your request to add $${request.amount} has been approved and added to your account.`,
        type: "success",
        created_at: new Date().toISOString(),
      });

      res.json({
        success: true,
        message: "Request approved and funds added successfully",
        request_id: id,
      });
    } catch (error) {
      console.error("Approve error:", error);
      res.status(500).json({
        error: "Failed to approve request",
        details: error.message,
      });
    }
  },
);

// POST decline add money request
app.post(
  "/api/admin/add-money-requests/:id/decline",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;

    try {
      // Get the request first
      const { data: request, error: fetchError } = await supabase
        .from("add_money_requests")
        .select("*")
        .eq("id", id)
        .single();

      if (fetchError || !request) {
        return res.status(404).json({ error: "Request not found" });
      }

      if (request.status !== "pending") {
        return res.status(400).json({ error: "Request already processed" });
      }

      // Update request status
      const { error: updateError } = await supabase
        .from("add_money_requests")
        .update({
          status: "declined",
          admin_note: reason || "Declined by admin",
          processed_at: new Date().toISOString(),
          processed_by: req.user.id,
        })
        .eq("id", id);

      if (updateError) throw updateError;

      // Send notification to user
      await supabase.from("notifications").insert({
        user_id: request.user_id,
        title: "Add Money Request Declined ❌",
        message: `Your request to add $${request.amount} was declined. Reason: ${reason || "Not specified"}`,
        type: "error",
        created_at: new Date().toISOString(),
      });

      res.json({
        success: true,
        message: "Request declined successfully",
        request_id: id,
      });
    } catch (error) {
      console.error("Decline error:", error);
      res.status(500).json({
        error: "Failed to decline request",
        details: error.message,
      });
    }
  },
);

// ADMIN - List of users who ever sent a message
app.get(
  "/api/admin/live-chat/users",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      // Step 1: Get distinct user_ids that have at least one message
      const { data: userIdsData, error: idsError } = await supabase
        .from("live_support_messages")
        .select("user_id")
        .order("created_at", { ascending: false });

      if (idsError) {
        console.error("Error fetching user_ids:", idsError);
        throw idsError;
      }

      if (!userIdsData || userIdsData.length === 0) {
        return res.json({ users: [] });
      }

      // Step 2: Get unique user_ids
      const uniqueUserIds = [...new Set(userIdsData.map((row) => row.user_id))];

      // Step 3: Fetch user details for those IDs
      const { data: usersData, error: usersError } = await supabase
        .from("users")
        .select("id, first_name, last_name, email")
        .in("id", uniqueUserIds);

      if (usersError) {
        console.error("Error fetching users:", usersError);
        throw usersError;
      }

      // Step 4: Format response
      const formattedUsers = (usersData || []).map((user) => ({
        user_id: user.id,
        name:
          `${user.first_name || ""} ${user.last_name || ""}`.trim() ||
          "Unknown",
        email: user.email || "no-email@found.com",
      }));

      res.json({ users: formattedUsers });
    } catch (err) {
      console.error(
        "ADMIN /live-chat/users CRASH:",
        err.message,
        err.details || err,
      );
      res.status(500).json({
        error: "Failed to load conversations",
        debug: err.message, // ← helpful in dev, remove in prod if you want
      });
    }
  },
);

// ADMIN SIDE - Get messages for a specific user
app.get(
  "/api/admin/live-chat/:userId",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { userId } = req.params;
      const { data, error } = await supabase
        .from("live_support_messages")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: true });

      if (error) throw error;
      res.json({ messages: data || [] });
    } catch (error) {
      res.status(500).json({ error: "Failed to load chat" });
    }
  },
);

// ADMIN SIDE - Reply as admin
app.post(
  "/api/admin/live-chat/:userId",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { userId } = req.params;
      const { message } = req.body;

      if (!message?.trim()) {
        return res.status(400).json({ error: "Message cannot be empty" });
      }

      const { error } = await supabase.from("live_support_messages").insert({
        user_id: userId,
        admin_id: req.user.id,
        message: message.trim(),
        is_from_admin: true,
        status: "sent",
      });

      if (error) throw error;
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to send reply" });
    }
  },
);

// Get all users (admin) - Updated
app.get("/api/admin/users", authenticate, authorizeAdmin, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      search,
      status,
      sort_by = "created_at",
      sort_order = "desc",
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);

    let countQuery = supabase
      .from("users")
      .select("*", { count: "exact", head: true });
    let dataQuery = supabase.from("users").select(`
        id,
        email,
        first_name,
        last_name,
        middle_name,
        phone,
        role,
        kyc_status,
        is_active,
        is_frozen,
        face_verified,
        passcode_hash,
        created_at
      `);

    // Apply filters
    if (search) {
      const searchFilter = `email.ilike.%${search}%,first_name.ilike.%${search}%,last_name.ilike.%${search}%`;
      countQuery = countQuery.or(searchFilter);
      dataQuery = dataQuery.or(searchFilter);
    }

    if (status === "frozen") {
      countQuery = countQuery.eq("is_frozen", true);
      dataQuery = dataQuery.eq("is_frozen", true);
    } else if (status === "active") {
      countQuery = countQuery.eq("is_active", true).eq("is_frozen", false);
      dataQuery = dataQuery.eq("is_active", true).eq("is_frozen", false);
    } else if (status === "inactive") {
      countQuery = countQuery.eq("is_active", false);
      dataQuery = dataQuery.eq("is_active", false);
    }

    // Execute queries
    const [countResult, dataResult] = await Promise.all([
      countQuery,
      dataQuery
        .order(sort_by, { ascending: sort_order === "asc" })
        .range(offset, offset + parseInt(limit) - 1),
    ]);

    if (dataResult.error) throw dataResult.error;

    // Get user IDs
    const userIds = (dataResult.data || []).map((u) => u.id);
    let balances = {};
    let faceDescriptorCounts = {};

    if (userIds.length > 0) {
      // Get balances
      const { data: accountsData } = await supabase
        .from("accounts")
        .select("user_id, balance")
        .in("user_id", userIds);

      balances = (accountsData || []).reduce((acc, accRow) => {
        acc[accRow.user_id] =
          (acc[accRow.user_id] || 0) + (accRow.balance || 0);
        return acc;
      }, {});

      // Get face descriptor counts
      const { data: faceData } = await supabase
        .from("face_descriptors")
        .select("user_id")
        .in("user_id", userIds)
        .eq("is_active", true);

      faceDescriptorCounts = (faceData || []).reduce((acc, fd) => {
        acc[fd.user_id] = (acc[fd.user_id] || 0) + 1;
        return acc;
      }, {});
    }

    // Merge data
    const usersWithDetails = (dataResult.data || []).map((user) => ({
      ...user,
      total_balance: balances[user.id] || 0,
      has_passcode: !!user.passcode_hash,
      face_descriptor_count: faceDescriptorCounts[user.id] || 0,
      passcode_hash: undefined, // Remove sensitive data
    }));

    res.json({
      users: usersWithDetails,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: countResult.count || 0,
        pages: Math.ceil((countResult.count || 0) / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error("Admin users fetch error:", error);
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

// GET /api/admin/accounts
app.get(
  "/api/admin/accounts",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 20;
      const offset = (page - 1) * limit;

      const {
        data: accounts,
        error,
        count,
      } = await supabase
        .from("accounts")
        .select(
          `
        id,
        account_number,
        account_type,
        currency,
        balance,
        available_balance,
        status,
        daily_limit,
        monthly_limit,
        created_at,
        user_id,
        users!accounts_user_id_fkey (id, email, first_name, last_name, is_frozen, kyc_status)
      `,
          { count: "exact" },
        )
        .range(offset, offset + limit - 1)
        .order("created_at", { ascending: false });

      if (error) throw error;

      res.json({
        accounts: accounts || [],
        pagination: {
          page,
          limit,
          total: count || 0,
          pages: Math.ceil((count || 0) / limit),
        },
      });
    } catch (err) {
      console.error("Admin accounts error:", err);
      res.status(500).json({ error: "Failed to load accounts" });
    }
  },
);

// Create user (admin)
app.post("/api/admin/users", authenticate, authorizeAdmin, async (req, res) => {
  try {
    const {
      email,
      password,
      first_name,
      last_name,
      phone,
      role = "user",
    } = req.body;

    // Check if user exists
    const { data: existingUser } = await supabase
      .from("users")
      .select("email")
      .eq("email", email)
      .single();

    if (existingUser) {
      return res.status(400).json({ error: "Email already registered" });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user
    const { data: user, error } = await supabase
      .from("users")
      .insert({
        email,
        password_hash: hashedPassword,
        first_name,
        last_name,
        phone,
        role,
        kyc_status: "verified",
      })
      .select()
      .single();

    if (error) throw error;

    // Create account for user
    await supabase.from("accounts").insert({
      user_id: user.id,
      account_type: "checking",
      currency: "NGN",
      balance: 0,
      available_balance: 0,
    });

    // Log admin action
    await supabase.from("admin_actions").insert({
      admin_id: req.user.id,
      action_type: "create_user",
      target_user_id: user.id,
      details: { created_by: req.user.email },
    });

    res.status(201).json({ message: "User created successfully", user });
  } catch (error) {
    console.error("Admin create user error:", error);
    res.status(500).json({ error: "Failed to create user" });
  }
});

// Update user (admin)
app.put(
  "/api/admin/users/:userId",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { userId } = req.params;
      const updates = req.body;

      // Remove sensitive fields
      delete updates.password_hash;
      delete updates.id;
      delete updates.created_at;

      const { data: user, error } = await supabase
        .from("users")
        .update({
          ...updates,
          updated_at: new Date(),
        })
        .eq("id", userId)
        .select()
        .single();

      if (error) throw error;

      // Log admin action
      await supabase.from("admin_actions").insert({
        admin_id: req.user.id,
        action_type: "update_user",
        target_user_id: userId,
        details: updates,
      });

      res.json({ message: "User updated successfully", user });
    } catch (error) {
      console.error("Admin update user error:", error);
      res.status(500).json({ error: "Failed to update user" });
    }
  },
);

// Freeze/Unfreeze user account (admin)
app.post(
  "/api/admin/users/:userId/toggle-freeze",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { userId } = req.params;
      const { freeze, reason, unfreeze_method, unfreeze_payment_details } =
        req.body;

      const updates = {
        is_frozen: freeze,
        freeze_reason: freeze ? reason : null,
        updated_at: new Date(),
      };

      if (freeze) {
        // Store unfreeze method and payment details
        updates.unfreeze_method = unfreeze_method;
        updates.unfreeze_payment_details = unfreeze_payment_details;
      } else {
        // Clear them when unfreezing
        updates.unfreeze_method = null;
        updates.unfreeze_payment_details = null;
      }

      const { data: user, error } = await supabase
        .from("users")
        .update(updates)
        .eq("id", userId)
        .select()
        .single();

      if (error) throw error;

      // Create notification for user
      await supabase.from("notifications").insert({
        user_id: userId,
        title: freeze ? "Account Frozen" : "Account Unfrozen",
        message: freeze
          ? `Your account has been frozen. Reason: ${reason || "Not specified"}.`
          : "Your account has been unfrozen.",
        type: freeze ? "warning" : "success",
      });

      // Log admin action
      await supabase.from("admin_actions").insert({
        admin_id: req.user.id,
        action_type: freeze ? "freeze_user" : "unfreeze_user",
        target_user_id: userId,
        details: { reason, unfreeze_method, unfreeze_payment_details },
      });

      res.json({
        message: freeze
          ? "Account frozen successfully"
          : "Account unfrozen successfully",
        user,
      });
    } catch (error) {
      console.error("Admin toggle freeze error:", error);
      res.status(500).json({ error: "Failed to toggle account freeze" });
    }
  },
);

// Verify KYC (admin)
app.post(
  "/api/admin/users/:userId/verify-kyc",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { userId } = req.params;
      const { status, notes } = req.body;

      await supabase
        .from("users")
        .update({
          kyc_status: status,
          updated_at: new Date(),
        })
        .eq("id", userId);

      // Create notification
      await supabase.from("notifications").insert({
        user_id: userId,
        title: "KYC Update",
        message: `Your KYC verification status is now: ${status}`,
        type: status === "verified" ? "success" : "warning",
      });

      // Log admin action
      await supabase.from("admin_actions").insert({
        admin_id: req.user.id,
        action_type: "verify_kyc",
        target_user_id: userId,
        details: { status, notes },
      });

      res.json({ message: "KYC status updated successfully" });
    } catch (error) {
      console.error("KYC verification error:", error);
      res.status(500).json({ error: "Failed to update KYC status" });
    }
  },
);

// Update user balance (admin)
app.post(
  "/api/admin/users/:userId/update-balance",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { userId } = req.params;
      const {
        account_id,
        amount,
        action,
        make_it_look_like_transfer,
        from_user_id,
        description,
      } = req.body;

      const { data: account } = await supabase
        .from("accounts")
        .select("*")
        .eq("id", account_id)
        .eq("user_id", userId)
        .single();

      if (!account) {
        return res.status(404).json({ error: "Account not found" });
      }

      let newBalance;
      if (action === "add") {
        newBalance = account.balance + amount;
      } else if (action === "subtract") {
        newBalance = account.balance - amount;
      } else if (action === "set") {
        newBalance = amount;
      }

      // Update balance
      await supabase
        .from("accounts")
        .update({
          balance: newBalance,
          available_balance: newBalance,
          updated_at: new Date(),
        })
        .eq("id", account_id);

      // Create transaction record
      const transactionData = {
        from_account_id:
          make_it_look_like_transfer && from_user_id ? account_id : null,
        to_account_id: make_it_look_like_transfer ? account_id : null,
        from_user_id:
          make_it_look_like_transfer && from_user_id ? from_user_id : null,
        to_user_id: make_it_look_like_transfer ? userId : null,
        amount: Math.abs(amount),
        description: description || `Admin balance adjustment: ${action}`,
        transaction_type: "admin_adjustment",
        status: "completed",
        completed_at: new Date(),
        is_admin_adjusted: true,
        admin_note: `Adjusted by admin ${req.user.email}`,
      };

      const { data: transaction } = await supabase
        .from("transactions")
        .insert(transactionData)
        .select()
        .single();

      // Create notification
      await supabase.from("notifications").insert({
        user_id: userId,
        title: "Balance Updated",
        message: `Your account balance has been updated. New balance: ₦${newBalance.toFixed(2)}`,
        type: "info",
      });

      // Log admin action
      await supabase.from("admin_actions").insert({
        admin_id: req.user.id,
        action_type: "update_balance",
        target_user_id: userId,
        details: {
          account_id,
          amount,
          action,
          make_it_look_like_transfer,
          from_user_id,
        },
      });

      res.json({
        message: "Balance updated successfully",
        new_balance: newBalance,
        transaction: make_it_look_like_transfer ? transaction : null,
      });
    } catch (error) {
      console.error("Admin update balance error:", error);
      res.status(500).json({ error: "Failed to update balance" });
    }
  },
);

// Impersonate user (admin)
app.post(
  "/api/admin/impersonate/:userId",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { userId } = req.params;

      // Get user details
      const { data: user } = await supabase
        .from("users")
        .select("*")
        .eq("id", userId)
        .single();

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Generate impersonation token
      const token = jwt.sign(
        {
          userId: user.id,
          email: user.email,
          role: user.role,
          isImpersonated: true,
          adminId: req.user.id,
        },
        process.env.JWT_SECRET,
        { expiresIn: "1h" },
      );

      // Log admin action
      await supabase.from("admin_actions").insert({
        admin_id: req.user.id,
        action_type: "impersonate",
        target_user_id: userId,
        details: { impersonated_by: req.user.email },
      });

      res.json({
        message: "Impersonation successful",
        token,
        user: {
          id: user.id,
          email: user.email,
          first_name: user.first_name,
          last_name: user.last_name,
          role: user.role,
          isImpersonated: true,
        },
      });
    } catch (error) {
      console.error("Impersonation error:", error);
      res.status(500).json({ error: "Impersonation failed" });
    }
  },
);

// Get all transactions (admin)
app.get(
  "/api/admin/transactions",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const {
        page = 1,
        limit = 50,
        user_id,
        type,
        status,
        start_date,
        end_date,
      } = req.query;
      const offset = (page - 1) * limit;

      let query = supabase
        .from("transactions")
        .select(
          "*, from_account:accounts!transactions_from_account_id_fkey(*), to_account:accounts!transactions_to_account_id_fkey(*)",
          { count: "exact" },
        );

      if (user_id) {
        query = query.or(`from_user_id.eq.${user_id},to_user_id.eq.${user_id}`);
      }

      if (type) {
        query = query.eq("transaction_type", type);
      }

      if (status) {
        query = query.eq("status", status);
      }

      if (start_date) {
        query = query.gte("created_at", start_date);
      }

      if (end_date) {
        query = query.lte("created_at", end_date);
      }

      const {
        data: transactions,
        count,
        error,
      } = await query
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) throw error;

      res.json({
        transactions,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: count,
          pages: Math.ceil(count / limit),
        },
      });
    } catch (error) {
      console.error("Admin transactions fetch error:", error);
      res.status(500).json({ error: "Failed to fetch transactions" });
    }
  },
);

// Approve/Reject transaction (admin)
app.post(
  "/api/admin/transactions/:transactionId/:action",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { transactionId, action } = req.params; // action: approve, reject
      const { reason } = req.body;

      const { data: transaction } = await supabase
        .from("transactions")
        .select("*")
        .eq("id", transactionId)
        .single();

      if (!transaction) {
        return res.status(404).json({ error: "Transaction not found" });
      }

      if (action === "approve" && transaction.status === "pending") {
        // Process transaction
        const { data: fromAccount } = await supabase
          .from("accounts")
          .select("*")
          .eq("id", transaction.from_account_id)
          .single();

        const { data: toAccount } = await supabase
          .from("accounts")
          .select("*")
          .eq("id", transaction.to_account_id)
          .single();

        // Update balances
        await supabase
          .from("accounts")
          .update({
            balance: fromAccount.balance - transaction.amount,
            available_balance:
              fromAccount.available_balance - transaction.amount,
          })
          .eq("id", transaction.from_account_id);

        await supabase
          .from("accounts")
          .update({
            balance: toAccount.balance + transaction.amount,
            available_balance: toAccount.available_balance + transaction.amount,
          })
          .eq("id", transaction.to_account_id);

        await supabase
          .from("transactions")
          .update({
            status: "completed",
            completed_at: new Date(),
          })
          .eq("id", transactionId);
      } else if (action === "reject") {
        await supabase
          .from("transactions")
          .update({
            status: "rejected",
            description:
              transaction.description + ` (Rejected: ${reason || "No reason"})`,
          })
          .eq("id", transactionId);
      }

      // Log admin action
      await supabase.from("admin_actions").insert({
        admin_id: req.user.id,
        action_type: `${action}_transaction`,
        target_user_id: transaction.from_user_id,
        details: { transaction_id: transactionId, reason },
      });

      res.json({ message: `Transaction ${action}d successfully` });
    } catch (error) {
      console.error("Admin transaction action error:", error);
      res.status(500).json({ error: `Failed to ${action} transaction` });
    }
  },
);

// Generate OTP (admin)
app.post(
  "/api/admin/generate-otp",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { user_id, otp_type, transaction_id } = req.body;

      const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

      const { data: otp, error } = await supabase
        .from("otps")
        .insert({
          user_id,
          otp_code: otpCode,
          otp_type,
          transaction_id,
          expires_at: expiresAt,
        })
        .select()
        .single();

      if (error) throw error;

      // Log admin action
      await supabase.from("admin_actions").insert({
        admin_id: req.user.id,
        action_type: "generate_otp",
        target_user_id: user_id,
        details: { otp_type, transaction_id },
      });

      res.json({
        message: "OTP generated successfully",
        otp_code: otpCode,
        expires_at: expiresAt,
        otp,
      });
    } catch (error) {
      console.error("OTP generation error:", error);
      res.status(500).json({ error: "Failed to generate OTP" });
    }
  },
);

// Toggle OTP mode (admin)
app.post(
  "/api/admin/toggle-otp-mode",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { mode } = req.body; // 'on' or 'off'

      await supabase.from("admin_settings").upsert(
        {
          setting_key: "otp_mode",
          setting_value: mode,
          updated_by: req.user.id,
          updated_at: new Date(),
        },
        { onConflict: "setting_key" },
      );

      // Also update related settings
      await supabase.from("admin_settings").upsert(
        {
          setting_key: "withdrawal_otp_required",
          setting_value: mode === "on" ? "true" : "false",
          updated_by: req.user.id,
          updated_at: new Date(),
        },
        { onConflict: "setting_key" },
      );

      await supabase.from("admin_settings").upsert(
        {
          setting_key: "transfer_otp_required",
          setting_value: mode === "on" ? "true" : "false",
          updated_by: req.user.id,
          updated_at: new Date(),
        },
        { onConflict: "setting_key" },
      );

      // Log admin action
      await supabase.from("admin_actions").insert({
        admin_id: req.user.id,
        action_type: "toggle_otp_mode",
        details: { mode },
      });

      res.json({ message: `OTP mode turned ${mode}` });
    } catch (error) {
      console.error("Toggle OTP mode error:", error);
      res.status(500).json({ error: "Failed to toggle OTP mode" });
    }
  },
);

// Get admin settings
app.get(
  "/api/admin/settings",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { data: settings, error } = await supabase
        .from("admin_settings")
        .select("*");

      if (error) throw error;

      res.json(settings);
    } catch (error) {
      console.error("Admin settings fetch error:", error);
      res.status(500).json({ error: "Failed to fetch settings" });
    }
  },
);

// Update admin settings
app.post(
  "/api/admin/settings",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const settings = req.body;

      for (const [key, value] of Object.entries(settings)) {
        await supabase.from("admin_settings").upsert(
          {
            setting_key: key,
            setting_value: value,
            updated_by: req.user.id,
            updated_at: new Date(),
          },
          { onConflict: "setting_key" },
        );
      }

      // Log admin action
      await supabase.from("admin_actions").insert({
        admin_id: req.user.id,
        action_type: "update_settings",
        details: settings,
      });

      res.json({ message: "Settings updated successfully" });
    } catch (error) {
      console.error("Admin settings update error:", error);
      res.status(500).json({ error: "Failed to update settings" });
    }
  },
);

// GET /api/user/transactions/category-summary
app.get(
  "/api/user/transactions/category-summary",
  authenticate,
  checkAccountFrozen,
  async (req, res) => {
    try {
      const { data, error } = await supabase
        .from("transactions")
        .select("amount, description, created_at, status")
        .eq("from_user_id", req.user.id) // outgoing only
        .eq("status", "completed")
        .gte(
          "created_at",
          new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        ); // last 30 days

      if (error) throw error;

      // Group by category
      const summary = data.reduce((acc, tx) => {
        const cat = tx.category || "Other";
        acc[cat] = (acc[cat] || 0) + Math.abs(tx.amount);
        return acc;
      }, {});

      // Convert to array for chart
      const result = Object.entries(summary).map(([category, total]) => ({
        category,
        total: Number(total.toFixed(2)),
      }));

      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to load category summary" });
    }
  },
);

// Get single user details (admin) - FIXED with face images
app.get(
  "/api/admin/users/:userId",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { userId } = req.params;

      // Get user with all fields
      const { data: user, error: userError } = await supabase
        .from("users")
        .select(
          `
          id,
          email,
          first_name,
          last_name,
          middle_name,
          phone,
          date_of_birth,
          age,
          gender,
          marital_status,
          occupation,
          referral_code,
          address,
          city,
          state,
          country,
          postal_code,
          identification_type,
          identification_number,
          security_question_1,
          security_question_2,
          role,
          kyc_status,
          is_active,
          is_frozen,
          freeze_reason,
          two_factor_enabled,
          face_verified,
          face_quality_score,
          face_embedding,
          created_at,
          updated_at,
          last_login
        `,
        )
        .eq("id", userId)
        .single();

      if (userError || !user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Get accounts
      const { data: accounts } = await supabase
        .from("accounts")
        .select("*")
        .eq("user_id", userId);

      // Get cards
      const { data: cards } = await supabase
        .from("cards")
        .select("*")
        .eq("user_id", userId);

      // Get recent transactions (last 50)
      const { data: transactions } = await supabase
        .from("transactions")
        .select(
          `
          id,
          transaction_id,
          amount,
          description,
          transaction_type,
          status,
          created_at,
          completed_at,
          from_account_id,
          to_account_id,
          from_user_id,
          to_user_id
        `,
        )
        .or(`from_user_id.eq.${userId},to_user_id.eq.${userId}`)
        .order("created_at", { ascending: false })
        .limit(50);

      // ========== FIXED: Get face descriptors with images ==========
      const { data: faceDescriptors } = await supabase
        .from("face_descriptors")
        .select("id, descriptor, created_at, is_active")
        .eq("user_id", userId)
        .eq("is_active", true)
        .order("created_at", { ascending: true })
        .limit(10); // Get up to 10 face images

      // Process face descriptors to extract images
      let processedFaceDescriptors = [];
      let firstFaceImage = null;

      if (faceDescriptors && faceDescriptors.length > 0) {
        processedFaceDescriptors = faceDescriptors
          .map((fd) => {
            // Check if descriptor contains an image
            let imageData = null;
            if (fd.descriptor) {
              if (typeof fd.descriptor === "object" && fd.descriptor.image) {
                imageData = fd.descriptor.image;
                if (!firstFaceImage) firstFaceImage = imageData;
              } else if (
                typeof fd.descriptor === "string" &&
                fd.descriptor.startsWith("data:image")
              ) {
                imageData = fd.descriptor;
                if (!firstFaceImage) firstFaceImage = imageData;
              }
            }
            return {
              id: fd.id,
              image: imageData,
              created_at: fd.created_at,
              is_active: fd.is_active,
            };
          })
          .filter((fd) => fd.image); // Only keep those with images
      }

      // Also check if user table has face_embedding with image
      let userFaceImage = null;
      if (user.face_embedding) {
        if (
          typeof user.face_embedding === "object" &&
          user.face_embedding.image
        ) {
          userFaceImage = user.face_embedding.image;
        } else if (
          typeof user.face_embedding === "string" &&
          user.face_embedding.startsWith("data:image")
        ) {
          userFaceImage = user.face_embedding;
        }
      }

      // Use the first available face image
      const finalFaceImage = firstFaceImage || userFaceImage;

      // Combine all data
      const completeUser = {
        ...user,
        accounts: accounts || [],
        cards: cards || [],
        transactions: transactions || [],
        face_descriptors: processedFaceDescriptors,
        face_descriptor_count: processedFaceDescriptors.length,
        face_image: finalFaceImage, // Add this field for easy access
        has_face_descriptor: processedFaceDescriptors.length > 0,
        has_passcode: !!user.passcode_hash,
      };

      res.json(completeUser);
    } catch (error) {
      console.error("Admin user fetch error:", error);
      res.status(500).json({
        error: "Failed to fetch user",
        details: error.message,
      });
    }
  },
);

// Update user (admin) - UPDATED with all fields
app.put(
  "/api/admin/users/:userId",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { userId } = req.params;
      const updates = req.body;

      // Remove any fields that shouldn't be updated
      const safeUpdates = {};
      const allowedFields = [
        "first_name",
        "last_name",
        "middle_name",
        "email",
        "phone",
        "date_of_birth",
        "age",
        "gender",
        "marital_status",
        "occupation",
        "referral_code",
        "address",
        "city",
        "state",
        "country",
        "postal_code",
        "role",
        "kyc_status",
        "identification_type",
        "identification_number",
        "is_active",
        "is_frozen",
        "freeze_reason",
        "two_factor_enabled",
        "face_verified",
      ];

      allowedFields.forEach((field) => {
        if (updates[field] !== undefined && updates[field] !== null) {
          safeUpdates[field] = updates[field];
        }
      });

      // Add timestamp
      safeUpdates.updated_at = new Date();

      // Check email uniqueness if changed
      if (safeUpdates.email) {
        const { data: existingUser } = await supabase
          .from("users")
          .select("id")
          .eq("email", safeUpdates.email)
          .neq("id", userId)
          .maybeSingle();

        if (existingUser) {
          return res.status(400).json({ error: "Email already in use" });
        }
      }

      // Update user
      const { data: user, error: updateError } = await supabase
        .from("users")
        .update(safeUpdates)
        .eq("id", userId)
        .select(
          `
          id,
          email,
          first_name,
          last_name,
          middle_name,
          phone,
          date_of_birth,
          age,
          gender,
          marital_status,
          occupation,
          role,
          kyc_status,
          is_active,
          is_frozen,
          face_verified
        `,
        )
        .single();

      if (updateError) {
        console.error("Update error:", updateError);
        return res.status(500).json({ error: "Failed to update user" });
      }

      // Log admin action
      await supabase.from("admin_actions").insert({
        admin_id: req.user.id,
        action_type: "update_user",
        target_user_id: userId,
        details: safeUpdates,
      });

      // Create notifications for important changes
      if (updates.is_frozen !== undefined) {
        await supabase.from("notifications").insert({
          user_id: userId,
          title: updates.is_frozen ? "Account Frozen" : "Account Unfrozen",
          message: updates.is_frozen
            ? `Your account has been frozen. Reason: ${updates.freeze_reason || "Not specified"}`
            : "Your account has been unfrozen.",
          type: updates.is_frozen ? "warning" : "success",
        });
      }

      res.json({
        message: "User updated successfully",
        user,
      });
    } catch (error) {
      console.error("Admin update user error:", error);
      res.status(500).json({ error: "Failed to update user" });
    }
  },
);

// Reset user password (admin)
app.post(
  "/api/admin/users/:userId/reset-password",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { userId } = req.params;

      // Generate temporary password
      const tempPassword =
        Math.random().toString(36).slice(-8) +
        Math.random().toString(36).slice(-8).toUpperCase() +
        "!1";
      const hashedPassword = await bcrypt.hash(tempPassword, 10);

      // Update password
      await supabase
        .from("users")
        .update({ password_hash: hashedPassword })
        .eq("id", userId);

      // Create notification
      await supabase.from("notifications").insert({
        user_id: userId,
        title: "Password Reset",
        message:
          "Your password has been reset by an administrator. Please check your email for the new temporary password.",
        type: "warning",
      });

      // In a real application, send email with temporary password
      console.log(`Temporary password for user ${userId}: ${tempPassword}`);

      // Log admin action
      await supabase.from("admin_actions").insert({
        admin_id: req.user.id,
        action_type: "reset_password",
        target_user_id: userId,
      });

      res.json({ message: "Password reset successfully" });
    } catch (error) {
      console.error("Admin reset password error:", error);
      res.status(500).json({ error: "Failed to reset password" });
    }
  },
);

// Get single transaction details (admin)
app.get(
  "/api/admin/transactions/:transactionId",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { transactionId } = req.params;

      const { data: transaction, error } = await supabase
        .from("transactions")
        .select(
          `
                *,
                from_account:accounts!transactions_from_account_id_fkey(*),
                to_account:accounts!transactions_to_account_id_fkey(*),
                from_user:users!transactions_from_user_id_fkey(first_name, last_name, email),
                to_user:users!transactions_to_user_id_fkey(first_name, last_name, email)
            `,
        )
        .eq("id", transactionId)
        .single();

      if (error) throw error;

      res.json(transaction);
    } catch (error) {
      console.error("Admin transaction fetch error:", error);
      res.status(500).json({ error: "Failed to fetch transaction" });
    }
  },
);

// Toggle card status (admin)
app.post(
  "/api/admin/cards/:cardId/toggle",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { cardId } = req.params;
      const { action } = req.body; // 'freeze' or 'unfreeze'

      const newStatus = action === "freeze" ? "frozen" : "active";

      const { data: card, error } = await supabase
        .from("cards")
        .update({ card_status: newStatus })
        .eq("id", cardId)
        .select()
        .single();

      if (error) throw error;

      // Create notification for user
      await supabase.from("notifications").insert({
        user_id: card.user_id,
        title: `Card ${action}d`,
        message: `Your card ending in ${card.card_number.slice(-4)} has been ${action}d by an administrator.`,
        type: "warning",
      });

      // Log admin action
      await supabase.from("admin_actions").insert({
        admin_id: req.user.id,
        action_type: `card_${action}`,
        target_user_id: card.user_id,
        details: { card_id: cardId },
      });

      res.json({ message: `Card ${action}d successfully`, card });
    } catch (error) {
      console.error("Admin toggle card error:", error);
      res.status(500).json({ error: "Failed to toggle card" });
    }
  },
);

// Report card as lost/stolen (admin)
app.post(
  "/api/admin/cards/:cardId/report",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { cardId } = req.params;

      const { data: card, error } = await supabase
        .from("cards")
        .update({ card_status: "lost" })
        .eq("id", cardId)
        .select()
        .single();

      if (error) throw error;

      // Create notification for user
      await supabase.from("notifications").insert({
        user_id: card.user_id,
        title: "Card Reported Lost/Stolen",
        message: `Your card ending in ${card.card_number.slice(-4)} has been reported as lost/stolen. A new card will be issued.`,
        type: "danger",
      });

      // Create support ticket
      await supabase.from("support_tickets").insert({
        user_id: card.user_id,
        subject: "Lost/Stolen Card Reported",
        message: `Card ending in ${card.card_number.slice(-4)} reported as lost/stolen by administrator.`,
        priority: "high",
      });

      // Log admin action
      await supabase.from("admin_actions").insert({
        admin_id: req.user.id,
        action_type: "card_report_lost",
        target_user_id: card.user_id,
        details: { card_id: cardId },
      });

      res.json({ message: "Card reported successfully", card });
    } catch (error) {
      console.error("Admin report card error:", error);
      res.status(500).json({ error: "Failed to report card" });
    }
  },
);

// FIXED: GET /api/admin/support-tickets (no more 500)
app.get(
  "/api/admin/support-tickets",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { status, search } = req.query;

      let query = supabase
        .from("support_tickets")
        .select(
          `
                *,
                users!user_id (first_name, last_name, email)
            `,
        )
        .order("created_at", { ascending: false });

      if (status) query = query.eq("status", status);
      if (search) query = query.ilike("subject", `%${search}%`);

      const { data: tickets, error } = await query;

      if (error) throw error;

      res.json({ tickets: tickets || [] });
    } catch (err) {
      console.error("Support tickets error:", err.message);
      res.status(500).json({ error: "Failed to load tickets" });
    }
  },
);

// Get support tickets (admin)
app.get(
  "/api/admin/support-tickets",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { status, priority, page = 1, limit = 20 } = req.query;
      const offset = (page - 1) * limit;

      let query = supabase
        .from("support_tickets")
        .select("*, user:users(first_name, last_name, email)", {
          count: "exact",
        });

      if (status) {
        query = query.eq("status", status);
      }

      if (priority) {
        query = query.eq("priority", priority);
      }

      const {
        data: tickets,
        count,
        error,
      } = await query
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) throw error;

      res.json({
        tickets,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: count,
          pages: Math.ceil(count / limit),
        },
      });
    } catch (error) {
      console.error("Admin tickets fetch error:", error);
      res.status(500).json({ error: "Failed to fetch support tickets" });
    }
  },
);

// ==================== FIXED SUPPORT TICKET MESSAGES ROUTE ====================

// Get messages for a support ticket (admin) - FIXED
app.get(
  "/api/admin/support-tickets/:ticketId/messages",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { ticketId } = req.params;

      // First verify ticket exists
      const { data: ticket, error: ticketError } = await supabase
        .from("support_tickets")
        .select("id, user_id, status")
        .eq("id", ticketId)
        .single();

      if (ticketError || !ticket) {
        return res.status(404).json({ error: "Ticket not found" });
      }

      // Get messages with sender info
      const { data: messages, error } = await supabase
        .from("chat_messages")
        .select(
          `
          *,
          sender:sender_id (id, first_name, last_name, email, role)
        `,
        )
        .eq("ticket_id", ticketId)
        .order("created_at", { ascending: true });

      if (error) {
        console.error("Messages fetch error:", error);
        return res.status(500).json({ error: "Failed to fetch messages" });
      }

      // Also get user info for the ticket
      const { data: user } = await supabase
        .from("users")
        .select("first_name, last_name, email")
        .eq("id", ticket.user_id)
        .single();

      res.json({
        messages: messages || [],
        ticket: {
          id: ticket.id,
          status: ticket.status,
          user: user,
        },
      });
    } catch (error) {
      console.error("Support ticket messages error:", error);
      res.status(500).json({ error: "Failed to fetch ticket messages" });
    }
  },
);

// Reply to support ticket (admin)
app.post(
  "/api/admin/support-tickets/:ticketId/reply",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { ticketId } = req.params;
      const { message } = req.body;

      // Update ticket status
      await supabase
        .from("support_tickets")
        .update({
          status: "in_progress",
          updated_at: new Date(),
        })
        .eq("id", ticketId);

      // Add admin reply
      const { data: reply } = await supabase
        .from("chat_messages")
        .insert({
          ticket_id: ticketId,
          sender_id: req.user.id,
          message,
          is_admin_reply: true,
        })
        .select()
        .single();

      // Get ticket to get user_id
      const { data: ticket } = await supabase
        .from("support_tickets")
        .select("user_id")
        .eq("id", ticketId)
        .single();

      // Create notification for user
      await supabase.from("notifications").insert({
        user_id: ticket.user_id,
        title: "New Support Reply",
        message: "An admin has replied to your support ticket",
        type: "info",
        action_url: `/support/${ticketId}`,
      });

      res.json({ message: "Reply sent successfully", reply });
    } catch (error) {
      console.error("Admin ticket reply error:", error);
      res.status(500).json({ error: "Failed to send reply" });
    }
  },
);

// Close support ticket (admin)
app.post(
  "/api/admin/support-tickets/:ticketId/close",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { ticketId } = req.params;
      const { resolution } = req.body;

      await supabase
        .from("support_tickets")
        .update({
          status: "closed",
          updated_at: new Date(),
        })
        .eq("id", ticketId);

      // Get ticket to get user_id
      const { data: ticket } = await supabase
        .from("support_tickets")
        .select("user_id")
        .eq("id", ticketId)
        .single();

      // Create notification
      await supabase.from("notifications").insert({
        user_id: ticket.user_id,
        title: "Support Ticket Closed",
        message: resolution || "Your support ticket has been closed",
        type: "info",
      });

      res.json({ message: "Ticket closed successfully" });
    } catch (error) {
      console.error("Admin close ticket error:", error);
      res.status(500).json({ error: "Failed to close ticket" });
    }
  },
);

// Process bulk operations (admin)
app.post(
  "/api/admin/bulk-operations",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { operation, users, amount, description } = req.body;
      const bulkReference = uuidv4();

      const results = [];

      for (const userId of users) {
        try {
          if (operation === "deposit") {
            // Get user's primary account
            const { data: account } = await supabase
              .from("accounts")
              .select("*")
              .eq("user_id", userId)
              .eq("account_type", "checking")
              .single();

            if (account) {
              await supabase
                .from("accounts")
                .update({
                  balance: account.balance + amount,
                  available_balance: account.available_balance + amount,
                })
                .eq("id", account.id);

              await supabase.from("transactions").insert({
                to_account_id: account.id,
                to_user_id: userId,
                amount,
                description: description || "Bulk deposit",
                transaction_type: "bulk_deposit",
                status: "completed",
                completed_at: new Date(),
                is_bulk: true,
                bulk_reference: bulkReference,
              });

              results.push({ userId, status: "success" });
            }
          } else if (operation === "withdrawal") {
            // Similar logic for withdrawal
          }
        } catch (error) {
          results.push({ userId, status: "failed", error: error.message });
        }
      }

      // Log admin action
      await supabase.from("admin_actions").insert({
        admin_id: req.user.id,
        action_type: "bulk_operation",
        details: {
          operation,
          users_count: users.length,
          amount,
          bulk_reference: bulkReference,
          results,
        },
      });

      res.json({
        message: "Bulk operation completed",
        bulk_reference: bulkReference,
        results,
      });
    } catch (error) {
      console.error("Bulk operation error:", error);
      res.status(500).json({ error: "Bulk operation failed" });
    }
  },
);

// ==================== ADMIN LOGS ROUTES ====================

// Get admin action logs with pagination and filters
app.get("/api/admin/logs", authenticate, authorizeAdmin, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      action_type,
      target_user_id,
      start_date,
      end_date,
      search,
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = supabase
      .from("admin_actions")
      .select(
        `
          *,
          admin:admin_id (id, email, first_name, last_name),
          target_user:target_user_id (id, email, first_name, last_name)
        `,
        { count: "exact" },
      )
      .order("created_at", { ascending: false });

    // Apply filters
    if (action_type && action_type !== "all") {
      query = query.eq("action_type", action_type);
    }

    if (target_user_id) {
      query = query.eq("target_user_id", target_user_id);
    }

    if (start_date) {
      query = query.gte("created_at", start_date);
    }

    if (end_date) {
      query = query.lte("created_at", `${end_date}T23:59:59`);
    }

    if (search) {
      query = query.or(
        `action_type.ilike.%${search}%,details::text.ilike.%${search}%`,
      );
    }

    const {
      data: logs,
      error,
      count,
    } = await query.range(offset, offset + parseInt(limit) - 1);

    if (error) throw error;

    // Get unique action types for filter dropdown
    const { data: actionTypes } = await supabase
      .from("admin_actions")
      .select("action_type")
      .limit(100);

    const uniqueActionTypes = [
      ...new Set((actionTypes || []).map((a) => a.action_type)),
    ];

    res.json({
      logs: logs || [],
      action_types: uniqueActionTypes,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count || 0,
        pages: Math.ceil((count || 0) / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error("Admin logs fetch error:", error);
    res.status(500).json({ error: "Failed to fetch admin logs" });
  }
});

// Get single log details
app.get(
  "/api/admin/logs/:logId",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { logId } = req.params;

      const { data: log, error } = await supabase
        .from("admin_actions")
        .select(
          `
          *,
          admin:admin_id (id, email, first_name, last_name),
          target_user:target_user_id (id, email, first_name, last_name)
        `,
        )
        .eq("id", logId)
        .single();

      if (error) throw error;

      res.json(log);
    } catch (error) {
      console.error("Admin log fetch error:", error);
      res.status(500).json({ error: "Failed to fetch log details" });
    }
  },
);

// Get admin dashboard stats
app.get("/api/admin/stats", authenticate, authorizeAdmin, async (req, res) => {
  try {
    // Total users
    const { count: totalUsers } = await supabase
      .from("users")
      .select("*", { count: "exact", head: true });

    // Active users (not frozen, active)
    const { count: activeUsers } = await supabase
      .from("users")
      .select("*", { count: "exact", head: true })
      .eq("is_active", true)
      .eq("is_frozen", false);

    // Frozen users
    const { count: frozenUsers } = await supabase
      .from("users")
      .select("*", { count: "exact", head: true })
      .eq("is_frozen", true);

    // Pending KYC
    const { count: pendingKYC } = await supabase
      .from("users")
      .select("*", { count: "exact", head: true })
      .eq("kyc_status", "pending");

    // Face verified users
    const { count: faceVerifiedUsers } = await supabase
      .from("users")
      .select("*", { count: "exact", head: true })
      .eq("face_verified", true);

    // Users with passcode set
    const { count: passcodeUsers } = await supabase
      .from("users")
      .select("*", { count: "exact", head: true })
      .not("passcode_hash", "is", null);

    // Total transactions today
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const { count: todayTransactions } = await supabase
      .from("transactions")
      .select("*", { count: "exact", head: true })
      .gte("created_at", today.toISOString());

    // Total volume today
    const { data: volumeData } = await supabase
      .from("transactions")
      .select("amount")
      .gte("created_at", today.toISOString())
      .eq("status", "completed");

    const todayVolume = volumeData?.reduce((sum, t) => sum + t.amount, 0) || 0;

    // Open support tickets
    const { count: openTickets } = await supabase
      .from("support_tickets")
      .select("*", { count: "exact", head: true })
      .eq("status", "open");

    res.json({
      totalUsers,
      activeUsers,
      frozenUsers,
      pendingKYC,
      faceVerifiedUsers,
      passcodeUsers,
      todayTransactions,
      todayVolume,
      openTickets,
      timestamp: new Date(),
    });
  } catch (error) {
    console.error("Admin stats error:", error);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// Create default admin user
const createDefaultAdmin = async () => {
  try {
    const { data: existingAdmin } = await supabase
      .from("users")
      .select("email")
      .eq("email", process.env.ADMIN_EMAIL)
      .single();

    if (!existingAdmin) {
      const hashedPassword = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);

      await supabase.from("users").insert({
        email: process.env.ADMIN_EMAIL,
        password_hash: hashedPassword,
        first_name: "Admin",
        last_name: "User",
        role: "admin",
        kyc_status: "verified",
        is_active: true,
      });

      console.log("Default admin user created");
    }
  } catch (error) {
    console.error("Error creating default admin:", error);
  }
};

createDefaultAdmin();

// Add this instead (required for Vercel)
module.exports = app;

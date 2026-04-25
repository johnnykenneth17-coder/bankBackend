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

// Add this if missing (adjust path if your folder structure is different)
const {
  authenticate,
  authorizeAdmin,
  checkAccountFrozen,
  logAdminAction,
  otpRateLimiter,
} = require("../middleware/auth"); // ← relative path from api/index.js

// ONLY NOW declare app
const app = express();

// Security middleware FIRST (after app is declared)
app.use(helmet());

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

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: process.env.SMTP_PORT == 465, // true for 465, false for other ports
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// ==================== AUTHENTICATION ROUTES ====================

// Register - Updated to handle compressed images
app.post("/api/auth/register", async (req, res) => {
  try {
    const {
      email,
      password,
      first_name,
      last_name,
      phone,
      country,
      city,
      address,
      security_question_1,
      security_answer_1,
      security_question_2,
      security_answer_2,
      face_image,
    } = req.body;

    console.log("Registration attempt for:", email);
    console.log(
      "Face image received:",
      face_image
        ? `Yes, size: ${Math.round(face_image.length / 1024)}KB`
        : "No",
    );

    // Check if user exists
    const { data: existingUser } = await supabase
      .from("users")
      .select("email")
      .eq("email", email)
      .single();

    if (existingUser) {
      return res.status(400).json({ error: "Email already registered" });
    }

    // Validate face image (should be present)
    if (!face_image || face_image.length < 100) {
      return res.status(400).json({ error: "Face verification required" });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Hash security answers
    const hashedAnswer1 = await bcrypt.hash(
      security_answer_1.toLowerCase().trim(),
      10,
    );
    const hashedAnswer2 = await bcrypt.hash(
      security_answer_2.toLowerCase().trim(),
      10,
    );

    // Create user with all fields
    const { data: user, error } = await supabase
      .from("users")
      .insert({
        email,
        password_hash: hashedPassword,
        first_name,
        last_name,
        phone,
        country: country || null,
        city: city || null,
        address: address || null,
        security_question_1,
        security_answer_1: hashedAnswer1,
        security_question_2,
        security_answer_2: hashedAnswer2,
        face_image: face_image,
        face_verified: true,
        face_verification_date: new Date().toISOString(),
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

    // Create checking account for user
    const { error: accountError } = await supabase.from("accounts").insert({
      user_id: user.id,
      account_type: "checking",
      currency: "USD",
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

    // Return user data
    res.status(201).json({
      message: "User created successfully",
      token,
      user: {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        role: user.role,
        phone: user.phone,
        country: user.country,
        city: user.city,
        face_image: user.face_image,
      },
    });
  } catch (error) {
    console.error("Registration error:", error);
    res.status(500).json({ error: "Registration failed: " + error.message });
  }
});

// Login
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    // Get user
    const { data: user, error } = await supabase
      .from("users")
      .select("*")
      .eq("email", email)
      .single();

    if (error || !user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Check password
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Check if account is active
    if (!user.is_active) {
      return res.status(403).json({ error: "Account is deactivated" });
    }

    // Check 2FA
    if (user.two_factor_enabled) {
      return res.json({
        requiresTwoFactor: true,
        userId: user.id,
      });
    }

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
        is_frozen: user.is_frozen,
        kyc_status: user.kyc_status,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Login failed" });
  }
});

// ==================== FORGOT PASSWORD ROUTES ====================

// Step 1: Request OTP
app.post("/api/auth/forgot-password", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });

  const normalizedEmail = email.trim().toLowerCase();

  // Check if user exists (but don't reveal)
  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("email", normalizedEmail)
    .single();

  // Always return success to prevent email enumeration
  if (!user) {
    return res.json({
      message: "If your email is registered, you will receive a reset code.",
    });
  }

  // Generate 6-digit OTP
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  // Delete any existing OTP for this email (prev conflicts)
  await supabase.from("password_resets").delete().eq("email", normalizedEmail);

  // Insert new OTP
  const { error: insertError } = await supabase.from("password_resets").insert({
    email: normalizedEmail,
    otp,
    expires_at: expiresAt.toISOString(),
    used: false,
  });

  if (insertError) {
    console.error("Insert OTP error:", insertError);
    return res.status(500).json({ error: "Failed to generate reset code" });
  }

  // Send email
  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: normalizedEmail,
      subject: "Password Reset Code",
      html: `<h2>Your OTP: ${otp}</h2><p>Valid for 10 minutes.</p>`,
    });
  } catch (err) {
    console.error("Email error:", err);
    return res.status(500).json({ error: "Failed to send email" });
  }

  res.json({ message: "Reset code sent to your email" });
});

// Step 2: Verify OTP
app.post("/api/auth/verify-reset-otp", async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp)
    return res.status(400).json({ error: "Email and code required" });

  const normalizedEmail = email.trim().toLowerCase();
  const normalizedOtp = otp.trim();

  const { data: record, error } = await supabase
    .from("password_resets")
    .select("*")
    .eq("email", normalizedEmail)
    .eq("otp", normalizedOtp)
    .eq("used", false)
    .single();

  if (error || !record) {
    console.error("OTP lookup error:", error);
    return res.status(400).json({ error: "Invalid or expired code" });
  }

  if (new Date(record.expires_at) < new Date()) {
    return res.status(400).json({ error: "Code has expired" });
  }

  // Mark as used immediately
  await supabase
    .from("password_resets")
    .update({ used: true })
    .eq("id", record.id);

  res.json({ valid: true });
});

// step 3 reset password
app.post("/api/auth/reset-password", async (req, res) => {
  const { email, otp, new_password } = req.body;
  if (!email || !otp || !new_password) {
    return res.status(400).json({ error: "All fields required" });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const normalizedOtp = otp.trim();

  // Verify OTP again (must be used = true from previous step)
  const { data: record, error } = await supabase
    .from("password_resets")
    .select("*")
    .eq("email", normalizedEmail)
    .eq("otp", normalizedOtp)
    .eq("used", true)
    .single();

  if (error || !record || new Date(record.expires_at) < new Date()) {
    return res.status(400).json({ error: "Invalid or expired reset session" });
  }

  const hashedPassword = await bcrypt.hash(new_password, 10);
  const { error: updateError } = await supabase
    .from("users")
    .update({ password_hash: hashedPassword })
    .eq("email", normalizedEmail);

  if (updateError) {
    console.error("Password update error:", updateError);
    return res.status(500).json({ error: "Failed to update password" });
  }

  // Delete the used OTP record
  await supabase.from("password_resets").delete().eq("id", record.id);

  res.json({ message: "Password reset successful" });
});

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

// ==================== USER DASHBOARD ROUTES ====================

// Get user profile - Updated to return face image
app.get("/api/user/profile", authenticate, async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from("users")
      .select(
        "id, email, first_name, last_name, phone, date_of_birth, address, city, country, postal_code, kyc_status, two_factor_enabled, is_frozen, freeze_reason, face_image, created_at",
      )
      .eq("id", req.user.id)
      .single();

    if (error) throw error;

    console.log("Profile fetched for user:", user.id);
    console.log("Face image in profile:", user.face_image ? "Yes" : "No");

    res.json(user);
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

    // Verify current password
    const validPassword = await bcrypt.compare(
      current_password,
      req.user.password_hash,
    );
    if (!validPassword) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(new_password, 10);

    // Update password
    const { error } = await supabase
      .from("users")
      .update({ password_hash: hashedPassword })
      .eq("id", req.user.id);

    if (error) throw error;

    res.json({ message: "Password changed successfully" });
  } catch (error) {
    console.error("Password change error:", error);
    res.status(500).json({ error: "Failed to change password" });
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

// Get transactions
app.get(
  "/api/user/transactions",
  authenticate,
  checkAccountFrozen,
  async (req, res) => {
    try {
      const { page = 1, limit = 20 } = req.query;
      const offset = (page - 1) * limit;

      const { data: accounts } = await supabase
        .from("accounts")
        .select("id")
        .eq("user_id", req.user.id);

      const accountIds = accounts.map((a) => a.id);

      const { data: transactions, error } = await supabase
        .from("transactions")
        .select(
          `
                *,
                from_account:accounts!transactions_from_account_id_fkey(account_number),
                to_account:accounts!transactions_to_account_id_fkey(account_number)
            `,
        )
        .or(
          `from_account_id.in.(${accountIds.join(",")}),to_account_id.in.(${accountIds.join(",")})`,
        )
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) throw error;

      // Get total count
      const { count } = await supabase
        .from("transactions")
        .select("*", { count: "exact", head: true })
        .or(
          `from_account_id.in.(${accountIds.join(",")}),to_account_id.in.(${accountIds.join(",")})`,
        );

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
      console.error("Transactions fetch error:", error);
      res.status(500).json({ error: "Failed to fetch transactions" });
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

// Transfer money
app.post(
  "/api/user/transfer",
  authenticate,
  checkAccountFrozen,
  async (req, res) => {
    try {
      const {
        from_account_id,
        to_account_number,
        amount,
        description,
        requires_otp = true,
      } = req.body;

      // Check if OTP is required globally
      const { data: settings } = await supabase
        .from("admin_settings")
        .select("setting_value")
        .eq("setting_key", "otp_mode")
        .single();

      const otpMode = settings?.setting_value === "on";

      // Get source account
      const { data: fromAccount } = await supabase
        .from("accounts")
        .select("*")
        .eq("id", from_account_id)
        .eq("user_id", req.user.id)
        .single();

      if (!fromAccount) {
        return res.status(404).json({ error: "Source account not found" });
      }

      // Check balance
      if (fromAccount.available_balance < amount) {
        return res.status(400).json({ error: "Insufficient funds" });
      }

      // Get destination account
      const { data: toAccount } = await supabase
        .from("accounts")
        .select("*")
        .eq("account_number", to_account_number)
        .single();

      if (!toAccount) {
        return res.status(404).json({ error: "Destination account not found" });
      }

      // ========== PREVENT SELF-TRANSFER ==========
      // Check if the destination account belongs to the same user
      if (toAccount.user_id === req.user.id) {
        return res.status(400).json({
          error:
            "Cannot transfer money to your own account. Please use a different recipient account.",
        });
      }
      // ============================================

      // Check if destination account is frozen
      const { data: toUser } = await supabase
        .from("users")
        .select("is_frozen")
        .eq("id", toAccount.user_id)
        .single();

      if (toUser?.is_frozen) {
        return res.status(400).json({ error: "Destination account is frozen" });
      }

      // Create transaction
      const transactionData = {
        from_account_id,
        to_account_id: toAccount.id,
        from_user_id: req.user.id,
        to_user_id: toAccount.user_id,
        amount,
        description,
        transaction_type: "transfer",
        status: "pending",
      };

      if (otpMode && requires_otp) {
        transactionData.requires_otp = true;
        // Generate OTP
        const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

        const { data: transaction, error } = await supabase
          .from("transactions")
          .insert(transactionData)
          .select()
          .single();

        if (error) throw error;

        await supabase.from("otps").insert({
          user_id: req.user.id,
          transaction_id: transaction.id,
          otp_code: otpCode,
          otp_type: "transfer",
          expires_at: expiresAt,
        });

        return res.json({
          message: "OTP required to complete transfer",
          requires_otp: true,
          transaction_id: transaction.id,
        });
      }

      // Process transfer immediately
      transactionData.status = "completed";
      transactionData.completed_at = new Date();

      const { data: transaction, error } = await supabase
        .from("transactions")
        .insert(transactionData)
        .select()
        .single();

      if (error) throw error;

      // Update balances
      await supabase
        .from("accounts")
        .update({
          balance: fromAccount.balance - amount,
          available_balance: fromAccount.available_balance - amount,
        })
        .eq("id", from_account_id);

      await supabase
        .from("accounts")
        .update({
          balance: toAccount.balance + amount,
          available_balance: toAccount.available_balance + amount,
        })
        .eq("id", toAccount.id);

      // Create notification for recipient
      await supabase.from("notifications").insert({
        user_id: toAccount.user_id,
        title: "Money Received",
        message: `You have received $${amount} from ${req.user.first_name} ${req.user.last_name}`,
        type: "success",
      });

      res.json({
        message: "Transfer completed successfully",
        transaction,
      });
    } catch (error) {
      console.error("Transfer error:", error);
      res.status(500).json({ error: "Transfer failed" });
    }
  },
);

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

      if (amount < 10) {
        return res
          .status(400)
          .json({ error: "Minimum external transfer amount is $10" });
      }

      if (amount > 10000) {
        return res
          .status(400)
          .json({ error: "Maximum external transfer amount is $10,000" });
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

      const cardPrice = 10.0; // Card price

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

// Get beneficiaries
app.get(
  "/api/user/beneficiaries",
  authenticate,
  checkAccountFrozen,
  async (req, res) => {
    try {
      const { data: beneficiaries, error } = await supabase
        .from("beneficiaries")
        .select("*")
        .eq("user_id", req.user.id)
        .eq("is_active", true);

      if (error) throw error;

      res.json(beneficiaries);
    } catch (error) {
      console.error("Beneficiaries fetch error:", error);
      res.status(500).json({ error: "Failed to fetch beneficiaries" });
    }
  },
);

// Add beneficiary
app.post(
  "/api/user/beneficiaries",
  authenticate,
  checkAccountFrozen,
  async (req, res) => {
    try {
      const {
        beneficiary_name,
        account_number,
        bank_name,
        bank_code,
        relationship,
      } = req.body;

      const { data: beneficiary, error } = await supabase
        .from("beneficiaries")
        .insert({
          user_id: req.user.id,
          beneficiary_name,
          account_number,
          bank_name,
          bank_code,
          relationship,
        })
        .select()
        .single();

      if (error) throw error;

      res.json({ message: "Beneficiary added successfully", beneficiary });
    } catch (error) {
      console.error("Add beneficiary error:", error);
      res.status(500).json({ error: "Failed to add beneficiary" });
    }
  },
);

// Remove beneficiary
app.delete(
  "/api/user/beneficiaries/:id",
  authenticate,
  checkAccountFrozen,
  async (req, res) => {
    try {
      const { id } = req.params;

      await supabase
        .from("beneficiaries")
        .update({ is_active: false })
        .eq("id", id)
        .eq("user_id", req.user.id);

      res.json({ message: "Beneficiary removed successfully" });
    } catch (error) {
      console.error("Remove beneficiary error:", error);
      res.status(500).json({ error: "Failed to remove beneficiary" });
    }
  },
);

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

// Get notifications
app.get("/api/user/notifications", authenticate, async (req, res) => {
  try {
    const { data: notifications, error } = await supabase
      .from("notifications")
      .select("*")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) throw error;

    res.json(notifications);
  } catch (error) {
    console.error("Notifications fetch error:", error);
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

// Mark notification as read
app.post("/api/user/notifications/:id/read", authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    await supabase
      .from("notifications")
      .update({ is_read: true })
      .eq("id", id)
      .eq("user_id", req.user.id);

    res.json({ message: "Notification marked as read" });
  } catch (error) {
    console.error("Notification update error:", error);
    res.status(500).json({ error: "Failed to update notification" });
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

// Request unfreeze OTP
/*app.post("/api/user/request-unfreeze-otp", authenticate, async (req, res) => {
  try {
    if (!req.user.is_frozen) {
      return res.status(400).json({ error: "Account is not frozen" });
    }

    // Create unfreeze request ticket
    const { data: ticket } = await supabase
      .from("support_tickets")
      .insert({
        user_id: req.user.id,
        subject: "Account Unfreeze Request",
        message: `Account frozen reason: ${req.user.freeze_reason || "Not specified"}`,
        priority: "high",
      })
      .select()
      .single();

    // Create chat message
    await supabase.from("chat_messages").insert({
      ticket_id: ticket.id,
      sender_id: req.user.id,
      message: "I would like to request an OTP to unfreeze my account",
      is_admin_reply: false,
    });

    // Check if payment is required for unfreeze
    const { data: settings } = await supabase
      .from("admin_settings")
      .select("setting_value")
      .eq("setting_key", "freeze_otp_required")
      .single();

    const requiresPayment = settings?.setting_value === "true";

    res.json({
      message: "Unfreeze request sent. Please check chat for OTP code.",
      ticket_id: ticket.id,
      requires_payment: requiresPayment,
      payment_details: requiresPayment
        ? {
            amount: 5.0,
            method: "crypto",
            address: "0x742d35Cc6634C0532925a3b844Bc1e7f9c5f5f5f",
          }
        : null,
    });
  } catch (error) {
    console.error("Unfreeze request error:", error);
    res.status(500).json({ error: "Failed to request unfreeze" });
  }
});*/

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

// ==================== SAVINGS ROUTES ====================

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

// Start savings
app.post(
  "/api/user/savings/start",
  authenticate,
  checkAccountFrozen,
  async (req, res) => {
    const { type, amount, plan_id, target_withdrawal_date } = req.body;

    try {
      // Get primary account
      const { data: account, error: accError } = await supabase
        .from("accounts")
        .select("*")
        .eq("user_id", req.user.id)
        .eq("account_type", "checking")
        .single();

      if (accError || !account) {
        return res.status(404).json({ error: "Account not found" });
      }

      if (account.available_balance < amount) {
        return res.status(400).json({ error: "Insufficient funds" });
      }

      // Deduct amount
      await supabase
        .from("accounts")
        .update({
          balance: account.balance - amount,
          available_balance: account.available_balance - amount,
        })
        .eq("id", account.id);

      let savingsRecord;

      switch (type) {
        case "harvest":
          const { data: plan } = await supabase
            .from("harvest_plans")
            .select("*")
            .eq("id", plan_id)
            .single();

          const startDate = new Date();
          const endDate = new Date();
          endDate.setDate(endDate.getDate() + plan.duration_days);

          const { data: harvest, error: hError } = await supabase
            .from("user_harvest_enrollments")
            .insert({
              user_id: req.user.id,
              plan_id: plan_id,
              daily_amount: amount,
              total_saved: amount,
              days_completed: 1,
              start_date: startDate,
              expected_end_date: endDate,
              last_deduction_date: startDate,
            })
            .select()
            .single();

          if (hError) throw hError;
          savingsRecord = harvest;
          break;

        case "fixed":
          const maturityDate = new Date();
          maturityDate.setDate(maturityDate.getDate() + 30);
          const freeWithdrawalDate = new Date();
          freeWithdrawalDate.setDate(freeWithdrawalDate.getDate() + 30);
          freeWithdrawalDate.setDate(freeWithdrawalDate.getDate() + 2);

          const { data: fixed, error: fError } = await supabase
            .from("fixed_savings")
            .insert({
              user_id: req.user.id,
              amount: amount,
              start_date: new Date(),
              maturity_date: maturityDate,
              next_free_withdrawal_date: freeWithdrawalDate,
            })
            .select()
            .single();

          if (fError) throw fError;
          savingsRecord = fixed;
          break;

        case "savebox":
          const targetDate = new Date();
          targetDate.setMonth(targetDate.getMonth() + 1);

          const { data: savebox, error: sError } = await supabase
            .from("savebox_savings")
            .insert({
              user_id: req.user.id,
              amount: amount,
              target_date: targetDate,
            })
            .select()
            .single();

          if (sError) throw sError;
          savingsRecord = savebox;
          break;

        case "target":
          const withdrawalDate = new Date(target_withdrawal_date);
          const daysUntil = Math.ceil(
            (withdrawalDate - new Date()) / (1000 * 60 * 60 * 24),
          );
          const dailyAmount = amount / daysUntil;

          const { data: target, error: tError } = await supabase
            .from("target_savings")
            .insert({
              user_id: req.user.id,
              target_amount: amount,
              daily_savings_amount: dailyAmount,
              withdrawal_date: withdrawalDate,
              current_saved: amount,
              days_remaining: daysUntil - 1,
            })
            .select()
            .single();

          if (tError) throw tError;
          savingsRecord = target;
          break;
      }

      // Create transaction record
      await supabase.from("transactions").insert({
        from_account_id: account.id,
        from_user_id: req.user.id,
        amount: amount,
        description: `${type.charAt(0).toUpperCase() + type.slice(1)} Savings`,
        transaction_type: "savings",
        status: "completed",
        completed_at: new Date(),
      });

      // Create savings transaction
      await supabase.from("savings_transactions").insert({
        user_id: req.user.id,
        savings_type: type,
        savings_id: savingsRecord.id,
        amount: amount,
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
      res.status(500).json({ error: "Failed to start savings" });
    }
  },
);

// Get user's savings
app.get("/api/user/savings", authenticate, async (req, res) => {
  try {
    const [harvest, fixed, savebox, target] = await Promise.all([
      supabase
        .from("user_harvest_enrollments")
        .select("*, harvest_plans(name)")
        .eq("user_id", req.user.id)
        .eq("status", "active"),
      supabase
        .from("fixed_savings")
        .select("*")
        .eq("user_id", req.user.id)
        .eq("status", "active"),
      supabase
        .from("savebox_savings")
        .select("*")
        .eq("user_id", req.user.id)
        .eq("status", "active"),
      supabase
        .from("target_savings")
        .select("*")
        .eq("user_id", req.user.id)
        .eq("status", "active"),
    ]);

    const allSavings = [
      ...(harvest.data || []).map((h) => ({
        ...h,
        type: "harvest",
        plan_name: h.harvest_plans?.name,
      })),
      ...(fixed.data || []).map((f) => ({ ...f, type: "fixed" })),
      ...(savebox.data || []).map((s) => ({ ...s, type: "savebox" })),
      ...(target.data || []).map((t) => ({ ...t, type: "target" })),
    ];

    res.json(allSavings);
  } catch (error) {
    console.error("Error fetching savings:", error);
    res.status(500).json({ error: "Failed to fetch savings" });
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

// ==================== RECEIVE MONEY ROUTES ====================

// USER: Get receive methods for a specific country (fallback to 'ALL')
app.get("/api/user/receive-methods", authenticate, async (req, res) => {
  try {
    const { country, method } = req.query;
    if (!country) {
      return res.status(400).json({ error: "Country code required" });
    }

    let query = supabase
      .from("receive_methods")
      .select("*")
      .eq("is_active", true);

    if (method) {
      query = query.eq("method_type", method);
    }

    // First try specific country
    let { data: methods, error } = await query
      .eq("country_code", country)
      .order("method_type");

    // If no specific country, fallback to 'ALL'
    if (!methods || methods.length === 0) {
      const { data: fallback, error: fallbackError } = await query.eq(
        "country_code",
        "ALL",
      );
      if (!fallbackError && fallback) {
        methods = fallback;
      }
    }

    if (error) throw error;

    res.json({ methods: methods || [] });
  } catch (error) {
    console.error("Get receive methods error:", error);
    res.status(500).json({ error: "Failed to fetch receive methods" });
  }
});

// USER: Create a receive request
app.post("/api/user/receive-request", authenticate, async (req, res) => {
  try {
    const { amount, country_code, method_type, description } = req.body;

    // Validate
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }
    if (!country_code || !method_type) {
      return res.status(400).json({ error: "Country and method required" });
    }

    // Get the receive method details (for display)
    let { data: method, error: methodError } = await supabase
      .from("receive_methods")
      .select("*")
      .eq("country_code", country_code)
      .eq("method_type", method_type)
      .eq("is_active", true)
      .single();

    if (methodError || !method) {
      // Fallback to global
      const { data: fallback, error: fallbackError } = await supabase
        .from("receive_methods")
        .select("*")
        .eq("country_code", "ALL")
        .eq("method_type", method_type)
        .eq("is_active", true)
        .single();

      if (fallbackError || !fallback) {
        return res.status(404).json({
          error: "No receive method configured for this country/method",
        });
      }
      method = fallback;
    }

    // Create request
    const { data: request, error } = await supabase
      .from("receive_requests")
      .insert({
        user_id: req.user.id,
        amount,
        currency: "USD",
        country_code,
        method_type,
        description: description || null,
        status: "pending",
        payment_link: `${req.protocol}://${req.get("host")}/receive/${Math.random().toString(36).substring(2, 10)}`, // simple token
      })
      .select()
      .single();

    if (error) throw error;

    // Return the payment details from the method along with request ID
    res.json({
      success: true,
      message:
        "Receive request created. Share the following details with the sender.",
      request_id: request.id,
      payment_details: method.details,
      payment_link: request.payment_link,
      instructions:
        method_type === "bank"
          ? "Please instruct the sender to transfer the exact amount using the bank details above."
          : "Please instruct the sender to send the exact amount to the crypto address above.",
    });
  } catch (error) {
    console.error("Create receive request error:", error);
    res.status(500).json({ error: "Failed to create receive request" });
  }
});

// ADMIN: Get all receive methods
app.get(
  "/api/admin/receive-methods",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { data: methods, error } = await supabase
        .from("receive_methods")
        .select("*")
        .order("country_code")
        .order("method_type");

      if (error) throw error;
      res.json({ methods: methods || [] });
    } catch (error) {
      console.error("Admin get receive methods error:", error);
      res.status(500).json({ error: "Failed to fetch receive methods" });
    }
  },
);

// ADMIN: Create or update a receive method
app.post(
  "/api/admin/receive-methods",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { id, country_code, method_type, details, is_active } = req.body;

      if (!country_code || !method_type || !details) {
        return res
          .status(400)
          .json({ error: "Country, method type and details required" });
      }

      const methodData = {
        country_code,
        method_type,
        details,
        is_active: is_active !== undefined ? is_active : true,
        updated_at: new Date(),
        updated_by: req.user.id,
      };

      let result;
      if (id) {
        // Update existing
        const { data, error } = await supabase
          .from("receive_methods")
          .update(methodData)
          .eq("id", id)
          .select()
          .single();
        if (error) throw error;
        result = data;
      } else {
        // Insert new
        methodData.created_by = req.user.id;
        const { data, error } = await supabase
          .from("receive_methods")
          .insert(methodData)
          .select()
          .single();
        if (error) throw error;
        result = data;
      }

      // Log admin action
      await supabase.from("admin_actions").insert({
        admin_id: req.user.id,
        action_type: id ? "update_receive_method" : "create_receive_method",
        details: { id: result.id, country_code, method_type },
      });

      res.json({ success: true, method: result });
    } catch (error) {
      console.error("Admin save receive method error:", error);
      res.status(500).json({ error: "Failed to save receive method" });
    }
  },
);

// ADMIN: Delete receive method
app.delete(
  "/api/admin/receive-methods/:id",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;

      const { error } = await supabase
        .from("receive_methods")
        .delete()
        .eq("id", id);

      if (error) throw error;

      // Log admin action
      await supabase.from("admin_actions").insert({
        admin_id: req.user.id,
        action_type: "delete_receive_method",
        details: { id },
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Admin delete receive method error:", error);
      res.status(500).json({ error: "Failed to delete receive method" });
    }
  },
);

// ADMIN: Get receive requests (filter by status)
app.get(
  "/api/admin/receive-requests",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { status = "pending", page = 1, limit = 20 } = req.query;
      const offset = (page - 1) * limit;

      let query = supabase
        .from("receive_requests")
        .select(
          `
                *,
                user:users!receive_requests_user_id_fkey (
                    id,
                    first_name,
                    last_name,
                    email,
                    phone
                )
            `,
          { count: "exact" },
        )
        .order("created_at", { ascending: false });

      if (status !== "all") {
        query = query.eq("status", status);
      }

      const {
        data: requests,
        error,
        count,
      } = await query.range(offset, offset + limit - 1);

      if (error) throw error;

      res.json({
        requests: requests || [],
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: count || 0,
          pages: Math.ceil((count || 0) / limit),
        },
      });
    } catch (error) {
      console.error("Admin get receive requests error:", error);
      res.status(500).json({ error: "Failed to fetch receive requests" });
    }
  },
);

// ADMIN: Approve receive request (credit user)
app.post(
  "/api/admin/receive-requests/:id/approve",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;

      // Get request with user
      const { data: request, error: fetchError } = await supabase
        .from("receive_requests")
        .select("*, user:users(id, first_name, last_name, email)")
        .eq("id", id)
        .single();

      if (fetchError || !request) {
        return res.status(404).json({ error: "Request not found" });
      }

      if (request.status !== "pending") {
        return res.status(400).json({ error: "Request already processed" });
      }

      // Get user's primary account (checking)
      const { data: account, error: accountError } = await supabase
        .from("accounts")
        .select("*")
        .eq("user_id", request.user_id)
        .eq("account_type", "checking")
        .single();

      if (accountError || !account) {
        return res.status(404).json({ error: "User account not found" });
      }

      // Update account balance
      const newBalance = account.balance + request.amount;
      await supabase
        .from("accounts")
        .update({
          balance: newBalance,
          available_balance: newBalance,
          updated_at: new Date(),
        })
        .eq("id", account.id);

      // Create transaction record
      await supabase.from("transactions").insert({
        to_account_id: account.id,
        to_user_id: request.user_id,
        amount: request.amount,
        description:
          request.description ||
          `Incoming payment from ${request.country_code} via ${request.method_type}`,
        transaction_type: "incoming_payment",
        status: "completed",
        completed_at: new Date(),
        is_admin_adjusted: true,
        admin_note: `Approved by ${req.user.email}`,
      });

      // Update request status
      await supabase
        .from("receive_requests")
        .update({
          status: "approved",
          processed_at: new Date(),
          processed_by: req.user.id,
          admin_note: `Approved by ${req.user.email}`,
        })
        .eq("id", id);

      // Send notification to user
      await supabase.from("notifications").insert({
        user_id: request.user_id,
        title: "Payment Received ✅",
        message: `Your incoming payment of $${request.amount} has been approved and added to your account.`,
        type: "success",
        created_at: new Date(),
      });

      // Log admin action
      await supabase.from("admin_actions").insert({
        admin_id: req.user.id,
        action_type: "approve_receive_request",
        target_user_id: request.user_id,
        details: { request_id: id, amount: request.amount },
      });

      res.json({ success: true, message: "Request approved and funds added" });
    } catch (error) {
      console.error("Approve receive request error:", error);
      res.status(500).json({ error: "Failed to approve request" });
    }
  },
);

// ADMIN: Reject receive request (no credit, just mark)
app.post(
  "/api/admin/receive-requests/:id/reject",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { reason } = req.body;

      const { data: request, error: fetchError } = await supabase
        .from("receive_requests")
        .select("*")
        .eq("id", id)
        .single();

      if (fetchError || !request) {
        return res.status(404).json({ error: "Request not found" });
      }

      if (request.status !== "pending") {
        return res.status(400).json({ error: "Request already processed" });
      }

      await supabase
        .from("receive_requests")
        .update({
          status: "rejected",
          processed_at: new Date(),
          processed_by: req.user.id,
          admin_note: reason || `Rejected by ${req.user.email}`,
        })
        .eq("id", id);

      // No notification sent per requirement
      // Log admin action
      await supabase.from("admin_actions").insert({
        admin_id: req.user.id,
        action_type: "reject_receive_request",
        target_user_id: request.user_id,
        details: { request_id: id, reason },
      });

      res.json({ success: true, message: "Request rejected" });
    } catch (error) {
      console.error("Reject receive request error:", error);
      res.status(500).json({ error: "Failed to reject request" });
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

// Get all users (admin)
app.get("/api/admin/users", authenticate, authorizeAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status } = req.query;
    const offset = (page - 1) * limit;

    let query = supabase
      .from("users")
      .select("*, accounts(*)", { count: "exact" });

    if (search) {
      query = query.or(
        `email.ilike.%${search}%,first_name.ilike.%${search}%,last_name.ilike.%${search}%`,
      );
    }

    if (status) {
      if (status === "frozen") {
        query = query.eq("is_frozen", true);
      } else if (status === "active") {
        query = query.eq("is_active", true).eq("is_frozen", false);
      } else if (status === "inactive") {
        query = query.eq("is_active", false);
      }
    }

    const {
      data: users,
      count,
      error,
    } = await query
      .range(offset, offset + limit - 1)
      .order("created_at", { ascending: false });

    if (error) throw error;

    res.json({
      users,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        pages: Math.ceil(count / limit),
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
      currency: "USD",
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
        message: `Your account balance has been updated. New balance: $${newBalance.toFixed(2)}`,
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
// Get single user details using raw SQL
app.get(
  "/api/admin/users/:userId",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { userId } = req.params;

      // Use raw SQL query to avoid Supabase's ambiguous relationship handling
      const { data, error } = await supabase.rpc("get_user_complete_data", {
        user_id_param: userId,
      });

      if (error) {
        console.error("RPC error:", error);

        // Fallback to manual query if RPC fails
        return await getUserDataManually(userId, res);
      }

      res.json(data);
    } catch (error) {
      console.error("Admin user fetch error:", error);
      res.status(500).json({
        error: "Failed to fetch user",
        details: error.message,
      });
    }
  },
);

// Fallback manual function
async function getUserDataManually(userId, res) {
  try {
    // Get user
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("*")
      .eq("id", userId)
      .single();

    if (userError) throw userError;

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

    // Get all transactions (using union approach)
    const { data: transactions, error: transError } = await supabase
      .from("transactions")
      .select(
        `
                id,
                transaction_id,
                amount,
                currency,
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

    if (transError) {
      console.error("Transaction error:", transError);
    }

    // Get account details for each transaction
    const transactionsWithAccounts = await Promise.all(
      (transactions || []).map(async (t) => {
        let fromAccount = null;
        let toAccount = null;

        if (t.from_account_id) {
          const { data: acc } = await supabase
            .from("accounts")
            .select("id, account_number, account_type")
            .eq("id", t.from_account_id)
            .single();
          fromAccount = acc;
        }

        if (t.to_account_id) {
          const { data: acc } = await supabase
            .from("accounts")
            .select("id, account_number, account_type")
            .eq("id", t.to_account_id)
            .single();
          toAccount = acc;
        }

        return {
          ...t,
          from_account: fromAccount,
          to_account: toAccount,
        };
      }),
    );

    const completeUser = {
      ...user,
      accounts: accounts || [],
      cards: cards || [],
      transactions: transactionsWithAccounts || [],
    };

    res.json(completeUser);
  } catch (error) {
    console.error("Manual fetch error:", error);
    res.status(500).json({ error: "Failed to fetch user data" });
  }
}

// Update user (admin) - FIXED VERSION
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
        "email",
        "phone",
        "date_of_birth",
        "address",
        "city",
        "country",
        "postal_code",
        "role",
        "kyc_status",
        "id_type",
        "id_number",
        "is_active",
        "is_frozen",
        "freeze_reason",
        "two_factor_enabled",
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
          "id, email, first_name, last_name, role, kyc_status, is_active, is_frozen",
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

// Start server
/*const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});*/

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

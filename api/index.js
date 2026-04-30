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

// TEMPORARY DEBUG ROUTE - Put this FIRST
app.get("/api/test", (req, res) => {
    res.json({ message: "Server is working!", time: new Date().toISOString() });
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

// Get savings summary (check if user has active plans)
/*app.get("/api/user/savings/summary", authenticate, async (req, res) => {
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
        .select("id, status, auto_save, current_saved, target_amount, withdrawal_date")
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
    res.status(500).json({ error: "Failed to get savings summary: " + error.message });
  }
});*/

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



// Transfer money - COMPLETE FIXED VERSION with double-entry ledger
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

      console.log("=== TRANSFER REQUEST ===");
      console.log("From Account:", from_account_id);
      console.log("To Account Number:", to_account_number);
      console.log("Amount:", amount);
      console.log("User ID:", req.user.id);

      // Validate amount
      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Invalid amount" });
      }

      // Check if OTP is required globally
      const { data: settings } = await supabase
        .from("admin_settings")
        .select("setting_value")
        .eq("setting_key", "otp_mode")
        .single();

      const otpMode = settings?.setting_value === "on";

      // Get source account
      const { data: fromAccount, error: fromError } = await supabase
        .from("accounts")
        .select("*")
        .eq("id", from_account_id)
        .eq("user_id", req.user.id)
        .single();

      if (fromError || !fromAccount) {
        console.error("Source account error:", fromError);
        return res.status(404).json({ error: "Source account not found" });
      }

      console.log("Source account balance:", fromAccount.available_balance);

      // Check balance
      if (fromAccount.available_balance < amount) {
        return res.status(400).json({ error: "Insufficient funds" });
      }

      // Get destination account
      const { data: toAccount, error: toError } = await supabase
        .from("accounts")
        .select("*, users!inner(id, first_name, last_name, email, is_frozen)")
        .eq("account_number", to_account_number)
        .single();

      if (toError || !toAccount) {
        console.error("Destination account error:", toError);
        return res.status(404).json({ error: "Destination account not found" });
      }

      console.log("Destination account found:", toAccount.account_number);

      // PREVENT SELF-TRANSFER
      if (toAccount.user_id === req.user.id) {
        return res.status(400).json({
          error:
            "Cannot transfer money to your own account. Please use a different recipient account.",
        });
      }

      // Check if destination account is frozen
      if (toAccount.users?.is_frozen) {
        return res.status(400).json({ error: "Destination account is frozen" });
      }

      // Calculate fee (0.5% for internal transfers, min $0.50, max $10)
      let feeAmount = amount * 0.005;
      feeAmount = Math.min(Math.max(feeAmount, 500), 10000);
      const transferAmount = amount;
      const totalDeduction = transferAmount + feeAmount;

      // Check balance with fee
      if (fromAccount.available_balance < totalDeduction) {
        return res.status(400).json({
          error: `Insufficient funds. Amount: $${amount} + Fee: $${feeAmount.toFixed(2)} = $${totalDeduction.toFixed(2)}`,
        });
      }

      // Generate transaction ID
      const transactionId = `TXN${Date.now()}${Math.floor(Math.random() * 1000)}`;

      // Create transaction record
      const transactionData = {
        transaction_id: transactionId,
        from_account_id,
        to_account_id: toAccount.id,
        from_user_id: req.user.id,
        to_user_id: toAccount.user_id,
        amount: transferAmount,
        fee_amount: feeAmount,
        description: description || `Transfer to ${toAccount.account_number}`,
        transaction_type: "transfer",
        status: "pending",
        created_at: new Date().toISOString(),
      };

      if (otpMode && requires_otp) {
        transactionData.requires_otp = true;

        const { data: transaction, error: txError } = await supabase
          .from("transactions")
          .insert(transactionData)
          .select()
          .single();

        if (txError) throw txError;

        // Generate OTP
        const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

        await supabase.from("otps").insert({
          user_id: req.user.id,
          transaction_id: transaction.id,
          otp_code: otpCode,
          otp_type: "transfer",
          expires_at: expiresAt,
        });

        // Send OTP via email (optional)
        try {
          const { data: user } = await supabase
            .from("users")
            .select("email")
            .eq("id", req.user.id)
            .single();

          if (user?.email) {
            await transporter.sendMail({
              from: process.env.SMTP_FROM,
              to: user.email,
              subject: "Your Transfer OTP Code",
              html: `<h2>OTP Code: ${otpCode}</h2><p>Use this code to complete your transfer of $${amount}.</p><p>Valid for 10 minutes.</p>`,
            });
          }
        } catch (emailError) {
          console.error("Failed to send OTP email:", emailError);
        }

        return res.json({
          message: "OTP required to complete transfer",
          requires_otp: true,
          transaction_id: transaction.id,
        });
      }

      // Process transfer immediately (no OTP required)
      transactionData.status = "completed";
      transactionData.completed_at = new Date().toISOString();

      const { data: transaction, error: txError } = await supabase
        .from("transactions")
        .insert(transactionData)
        .select()
        .single();

      if (txError) throw txError;

      // Update sender's balance
      const newSenderBalance = fromAccount.balance - totalDeduction;
      const newSenderAvailable = fromAccount.available_balance - totalDeduction;

      const { error: updateSenderError } = await supabase
        .from("accounts")
        .update({
          balance: newSenderBalance,
          available_balance: newSenderAvailable,
          updated_at: new Date().toISOString(),
        })
        .eq("id", from_account_id);

      if (updateSenderError) throw updateSenderError;

      // Update receiver's balance
      const newReceiverBalance = toAccount.balance + transferAmount;
      const newReceiverAvailable = toAccount.available_balance + transferAmount;

      const { error: updateReceiverError } = await supabase
        .from("accounts")
        .update({
          balance: newReceiverBalance,
          available_balance: newReceiverAvailable,
          updated_at: new Date().toISOString(),
        })
        .eq("id", toAccount.id);

      if (updateReceiverError) throw updateReceiverError;

      // ==================== LEDGER ENTRIES ====================

      // Process double-entry for transfer
      await processDoubleEntry(
        transaction,
        req.user,
        fromAccount,
        toAccount,
        transferAmount,
        description,
        "transfer",
        feeAmount,
      );

      // Update single ledger for sender (Debit)
      await updateSingleLedger(
        fromAccount.id,
        req.user.id,
        totalDeduction,
        "transfer",
        `Transfer to ${toAccount.account_number} (${toAccount.users?.first_name || ""} ${toAccount.users?.last_name || ""})`,
        "Debit",
        transaction.id,
      );

      // Update single ledger for receiver (Credit)
      await updateSingleLedger(
        toAccount.id,
        toAccount.user_id,
        transferAmount,
        "transfer",
        `Transfer from ${fromAccount.account_number} (${req.user.first_name} ${req.user.last_name})`,
        "Credit",
        transaction.id,
      );

      // Create notification for sender
      await supabase.from("notifications").insert({
        user_id: req.user.id,
        title: "Transfer Completed",
        message: `You have successfully transferred $${transferAmount.toFixed(2)} to account ${toAccount.account_number}. Fee: $${feeAmount.toFixed(2)}`,
        type: "success",
        created_at: new Date().toISOString(),
      });

      // Create notification for recipient
      await supabase.from("notifications").insert({
        user_id: toAccount.user_id,
        title: "Money Received",
        message: `You have received $${transferAmount.toFixed(2)} from ${req.user.first_name} ${req.user.last_name}`,
        type: "success",
        created_at: new Date().toISOString(),
      });

      // Log admin action for large transfers (over $1000)
      if (amount > 1000) {
        await supabase.from("admin_actions").insert({
          admin_id: null,
          action_type: "large_transfer",
          target_user_id: req.user.id,
          details: {
            amount,
            to_user: toAccount.user_id,
            transaction_id: transaction.id,
          },
          created_at: new Date().toISOString(),
        });
      }

      console.log("Transfer completed successfully:", transaction.id);

      res.json({
        message: "Transfer completed successfully",
        transaction: {
          id: transaction.id,
          transaction_id: transaction.transaction_id,
          amount: transferAmount,
          fee: feeAmount,
          total_deducted: totalDeduction,
          new_balance: newSenderAvailable,
          description: transaction.description,
          completed_at: transaction.completed_at,
        },
        recipient: {
          name: `${toAccount.users?.first_name || ""} ${toAccount.users?.last_name || ""}`,
          account_number: toAccount.account_number,
        },
      });
    } catch (error) {
      console.error("Transfer error:", error);
      res.status(500).json({ error: "Transfer failed: " + error.message });
    }
  },
);

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
        .select("id, status, auto_save, current_saved, target_amount, withdrawal_date")
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
    res.status(500).json({ error: "Failed to get savings summary: " + error.message });
  }
});

// Changed from 'summary' to 'status' to avoid keyword conflicts
app.get("/api/user/savings/status", authenticate, async (req, res) => {
  try {
    console.log("Fetching savings status for user:", req.user.id);
    
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
        .select("id, status, auto_save, current_saved, target_amount, withdrawal_date")
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

    console.log("Savings status fetched successfully");
    
    res.json({
      success: true,
      total_saved: totalSaved,
      has_active_harvest: !!harvest.data,
      has_active_fixed: !!fixed.data,
      has_active_savebox: !!savebox.data,
      has_active_target: !!target.data,
      has_active_spare_change: !!spareChange.data,
      active_plans: {
        harvest: harvest.data || null,
        fixed: fixed.data || null,
        savebox: savebox.data || null,
        target: target.data || null,
        spare_change: spareChange.data || null,
      },
    });
  } catch (error) {
    console.error("Savings status error:", error);
    res.status(500).json({ error: "Failed to get savings status: " + error.message });
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
        case "harvest":
          // Multiple harvest plans allowed - no duplicate check needed
          const { data: plan, error: planError } = await supabase
            .from("harvest_plans")
            .select("*")
            .eq("id", plan_id)
            .single();

          if (planError) throw planError;

          const startDate = new Date();
          const endDate = new Date();
          endDate.setDate(endDate.getDate() + plan.duration_days);
          const nextDeduction = new Date();
          nextDeduction.setDate(nextDeduction.getDate() + 1);

          // Deduct initial amount
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
              days_completed: 1,
              start_date: startDate,
              expected_end_date: endDate,
              last_deduction_date: startDate,
              next_deduction_due: nextDeduction,
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
          const dailyAmount = amount / 30;

          const { data: fixed, error: fError } = await supabase
            .from("fixed_savings")
            .insert({
              user_id: req.user.id,
              amount: amount,
              current_saved: amount,
              daily_amount: dailyAmount,
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
          const saveboxDailyAmount = amount / 90;

          const { data: savebox, error: sError } = await supabase
            .from("savebox_savings")
            .insert({
              user_id: req.user.id,
              amount: amount,
              current_saved: amount,
              daily_amount: saveboxDailyAmount,
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
          // Deduct initial amount
          await supabase
            .from("accounts")
            .update({
              balance: account.balance - amount,
              available_balance: account.available_balance - amount,
            })
            .eq("id", account.id);

          const withdrawalDate = new Date(target_withdrawal_date);
          const daysUntil = Math.max(
            1,
            Math.ceil((withdrawalDate - new Date()) / (1000 * 60 * 60 * 24)),
          );
          const targetDailyAmount = amount / daysUntil;

          const { data: target, error: tError } = await supabase
            .from("target_savings")
            .insert({
              user_id: req.user.id,
              target_amount: amount,
              daily_savings_amount: targetDailyAmount,
              withdrawal_date: withdrawalDate,
              current_saved: amount,
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
    (harvest.data || []).forEach(h => {
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
    (fixed.data || []).forEach(f => {
      const today = new Date();
      const maturityDate = new Date(f.maturity_date);
      const isMatured = maturityDate <= today;
      
      allSavings.push({
        id: f.id,
        type: "fixed",
        amount: f.amount || 0,
        current_saved: f.current_saved || 0,
        daily_amount: f.daily_amount || (f.amount / 30),
        interest_rate: f.interest_rate || 5,
        maturity_date: f.maturity_date,
        status: isMatured ? "matured" : f.status,
        auto_save: f.auto_save || true,
        created_at: f.created_at,
      });
    });
    
    // Format savebox
    (savebox.data || []).forEach(s => {
      allSavings.push({
        id: s.id,
        type: "savebox",
        amount: s.amount || 0,
        current_saved: s.current_saved || 0,
        daily_amount: s.daily_amount || (s.amount / 90),
        target_date: s.target_date,
        early_withdrawal_fee_percent: s.early_withdrawal_fee_percent || 4,
        status: s.status,
        auto_save: s.auto_save || true,
        created_at: s.created_at,
      });
    });
    
    // Format target
    (target.data || []).forEach(t => {
      const withdrawalDate = new Date(t.withdrawal_date);
      const today = new Date();
      const canWithdraw = withdrawalDate <= today && (t.current_saved >= t.target_amount);
      
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
    (spareChange.data || []).forEach(s => {
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
    res.status(500).json({ error: "Failed to fetch savings: " + error.message });
  }
});

// Get single savings details (FIXED - get specific savings by type and id)
app.get("/api/user/savings/:type/:id", authenticate, async (req, res) => {
  const { type, id } = req.params;
  
  try {
    console.log(`Fetching ${type} savings ${id} for user:`, req.user.id);
    
    let result = null;
    const today = new Date();
    
    switch(type) {
      case "harvest":
        const { data: harvest, error: hError } = await supabase
          .from("user_harvest_enrollments")
          .select("*, harvest_plans(name, daily_amount, duration_days, reward_items)")
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
        const daysUntilMaturity = Math.max(0, Math.ceil((maturityDate - today) / (1000 * 60 * 60 * 24)));
        const isMatured = maturityDate <= today;
        const freeWithdrawalDate = new Date(fixed.next_free_withdrawal_date);
        const isFreeWithdrawal = isMatured && today <= freeWithdrawalDate;
        const interestEarned = (fixed.current_saved || 0) * (fixed.interest_rate / 100);
        
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
        const daysUntilWithdrawal = Math.max(0, Math.ceil((withdrawalDate - today) / (1000 * 60 * 60 * 24)));
        const percentComplete = target.target_amount > 0 ? (target.current_saved / target.target_amount) * 100 : 0;
        const canWithdraw = withdrawalDate <= today && target.current_saved >= target.target_amount;
        
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
    res.status(500).json({ error: "Failed to fetch savings details: " + error.message });
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
        currency: "NGN",
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

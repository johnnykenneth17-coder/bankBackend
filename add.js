

// Then all other middleware
app.use(express.json());
app.use(morgan("combined"));

// Supabase client (after dotenv)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// NOW all your routes
// app.post("/api/auth/register", ...)
// app.post("/api/auth/login", ...)
// ... rest of your routes ...

// Explicit OPTIONS handler (helps Vercel)
app.options("*", cors());

// NO app.listen() here — remove it completely if still present

// MUST be at the very bottom
module.exports = app;

























// Handle preflight OPTIONS for ALL routes explicitly
app.options("*", (req, res) => {
  const origin = req.headers.origin;

  // Allow your local dev origin + production frontend(s)
  const allowedOrigins = [
    "http://localhost:5500",
    "http://127.0.0.1:5500",
    "https://zivarabank.vercel.app", // ← add your real frontend domain here
    // add more if needed
  ];

  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*"); // temp for debugging
  }

  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, PATCH, OPTIONS",
  );
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400"); // cache preflight 24 hours

  return res.status(204).end();
});

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

const {
  authenticate,
  authorizeAdmin,
  checkAccountFrozen,
  logAdminAction,
  otpRateLimiter,
} = require("./middleware/auth");

const app = express();

// Security middleware
app.use(helmet());
app.use(
  cors({
    origin: process.env.FRONTEND_URL,
    credentials: true,
  }),
);
/*app.use(
  cors({
    origin: [
      "http://localhost:5500",
      "http://127.0.0.1:5500",
      "https://bank-backend-blush.vercel.app",        // your backend (sometimes needed)
      "https://zivarabank.vercel.app/",     // ← ADD YOUR FRONTEND URL HERE
      // you can add more later
    ],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);*/

/*const cors = require("cors");

// List ALL possible origins you want to allow
const allowedOrigins = [
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "https://zivarabank.vercel.app", // ← your actual production frontend
  "https://zivarabank-git-main-*.vercel.app", // ← for preview branches (optional but helpful)
  // Add your custom domain later if you attach one
];

app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (like mobile apps, curl, Postman)
      if (!origin) return callback(null, true);

      if (allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    // Important: helps with preflight caching
    optionsSuccessStatus: 200,
  }),
);*/

/*const cors = require("cors");

app.use(
  cors({
    origin: (origin, callback) => {
      // List of allowed origins - add your real production frontend domains here
      const allowedOrigins = [
        "http://localhost:5500",
        "http://127.0.0.1:5500",
        "https://zivarabank.vercel.app",           // ← your frontend domain
        "https://*.vercel.app",                     // allow preview / branch domains
        // "http://your-other-domain.com",          // add more if needed
      ];

      // For development & testing: allow requests with no origin (Postman, curl, etc.)
      if (!origin) {
        return callback(null, true);
      }

      // Allow if origin is in the list
      if (allowedOrigins.includes(origin) || allowedOrigins.some(o => origin.startsWith(o))) {
        callback(null, origin);   // reflect the requesting origin
      } else {
        // For debugging you can temporarily allow everything:
        // callback(null, true);
        
        // Normal behavior - reject unknown origins
        callback(new Error("Not allowed by CORS policy"));
      }
    },

    credentials: true,                        // very important if using cookies / auth headers

    methods: [
      "GET",
      "POST",
      "PUT",
      "DELETE",
      "PATCH",
      "OPTIONS"
    ],

    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
      "Accept",
      "Origin"
    ],

    exposedHeaders: ["Content-Length", "X-Content-Type-Options"],

    // Many people need this on Vercel because of preflight caching issues
    optionsSuccessStatus: 204,

    // Helps with some browser strictness
    preflightContinue: false
  })
);*/





// Add this if missing (adjust path if your folder structure is different)
const {
  authenticate,
  authorizeAdmin,
  checkAccountFrozen,
  logAdminAction,
  otpRateLimiter,
} = require("./middleware/auth");   // ← relative path from api/index.js






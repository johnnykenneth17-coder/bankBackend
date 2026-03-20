const cors = require("cors");

// List ALL possible origins you want to allow
const allowedOrigins = [
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "https://zivarabank.vercel.app",           // ← your actual production frontend
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
  })
);
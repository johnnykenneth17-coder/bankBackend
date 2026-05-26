// In index.js - REPLACE your existing CORS configuration with this:

app.use(
  cors({
    origin: (origin, callback) => {
      const allowed = [
        "http://127.0.0.1:5500",
        "http://127.0.0.1:5501",
        "http://localhost:5500",
        "http://localhost:5501",
        "https://localhost:5500",
        "https://bank-backend-blush.vercel.app",
        "https://zivarabank.vercel.app",
        "https://paystora.com",
        "http://paystora.com",
        "https://www.paystora.com",
        "http://www.paystora.com",
        /\.vercel\.app$/,  // Allow all vercel.app subdomains
      ];
      
      // Allow any origin in development
      if (!origin || process.env.NODE_ENV === 'development') {
        callback(null, true);
        return;
      }
      
      // Check against allowed origins
      const isAllowed = allowed.some(allowedOrigin => {
        if (allowedOrigin instanceof RegExp) {
          return allowedOrigin.test(origin);
        }
        return allowedOrigin === origin;
      });
      
      if (isAllowed) {
        callback(null, true);
      } else {
        console.log(`CORS blocked origin: ${origin}`);
        callback(null, true); // Still allow but log - change to false in production if needed
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
      "Accept",
      "Origin",
      "X-Device-ID",
      "X-Device-Fingerprint",
      "X-Device-Integrity",
      "X-Admin-Request",
      "x-device-id",        // Add lowercase version
      "X-Device-Id",        // Add alternative case
      "device-fingerprint",
      "X-Session-ID"
    ],
    exposedHeaders: ["Authorization"],
    optionsSuccessStatus: 204,
  })
);
app.use(
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
);
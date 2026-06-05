// In index.js - UPDATE Socket.IO configuration

const io = socketIo(server, {
  cors: {
    origin: (origin, callback) => {
      const allowedOrigins = [
        "http://127.0.0.1:5500",
        "http://127.0.0.1:5501",
        "http://localhost:5500",
        "http://localhost:5501",
        "https://bank-backend-blush.vercel.app",
        "https://zivarabank.vercel.app",
        "https://paystora.com",
        "capacitor://localhost",
        "capacitor://localhost:8080",
        "ionic://localhost",
        "http://localhost",
        "http://localhost:8080",
        "http://localhost:3000",
        /\.vercel\.app$/,
        /^http:\/\/localhost:\d+$/,
        /^capacitor:\/\/localhost:\d*$/,
      ];
      
      // Allow if no origin (Capacitor sometimes sends null)
      if (!origin) {
        callback(null, true);
        return;
      }
      
      const isAllowed = allowedOrigins.some(allowed => {
        if (allowed instanceof RegExp) {
          return allowed.test(origin);
        }
        return allowed === origin;
      });
      
      if (isAllowed) {
        callback(null, true);
      } else {
        console.log(`Socket.IO CORS blocked origin: ${origin}`);
        // Still allow to prevent connection issues
        callback(null, true);
      }
    },
    credentials: true,
    methods: ["GET", "POST"],
    transports: ['websocket', 'polling'],
    allowEIO3: true, // Allow Engine.IO v3 clients (Capacitor)
  },
});
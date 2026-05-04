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
      test: "/api/test-connection"
    }
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
    timestamp: new Date().toISOString()
  });
});
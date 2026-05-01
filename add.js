// api/index.js - Main entry point
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
// ... other imports

const app = express();

// ... middleware setup (helmet, cors, express.json, etc.)

// Import the main router
const mainRouter = require('./router');

// Mount all API routes - THIS GOES BEFORE any other route handlers
app.use('/api', mainRouter);

// Your existing routes can stay, but the router handles the savings ones
// So you can KEEP all your other working routes like:
// app.get("/api/user/profile", authenticate, ...)
// app.get("/api/user/accounts", authenticate, ...)
// app.post("/api/user/transfer", authenticate, checkAccountFrozen, ...)

// ... rest of your existing code (other routes, ledger routes, admin routes, etc.)

module.exports = app;
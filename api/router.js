// api/router.js - Central router that imports all route files
const express = require('express');
const savingsRouter = require('./savings');

const router = express.Router();

// Mount savings routes at /api/user/savings
router.use('/user/savings', savingsRouter);

// You can add other routers here as needed
// router.use('/user/accounts', accountsRouter);
// router.use('/admin', adminRouter);

module.exports = router;
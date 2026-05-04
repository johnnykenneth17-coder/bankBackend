// api/router.js
const express = require('express');
const savingsRouter = require('./saga/');

const router = express.Router();

// Mount savings routes at /api/user/savings
router.use('/user/savings', savingsRouter);

module.exports = router;
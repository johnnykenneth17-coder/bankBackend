// ============================================================
// GET FLUTTERWAVE BANKS
// ============================================================

app.get(
  '/api/flutterwave/banks',
  authenticate,
  async (req, res) => {
    try {
      // Check cache first (Redis recommended)
      const cacheKey = 'flutterwave_banks';
      const { data: cached } = await supabase
        .from('flutterwave_banks')
        .select('*')
        .eq('is_active', true)
        .order('sort_order', { ascending: true });

      if (cached && cached.length > 0) {
        return res.json({
          success: true,
          banks: cached,
          source: 'cache'
        });
      }

      // Fetch from Flutterwave
      const response = await axios.get(
        `${process.env.FLUTTERWAVE_BASE_URL}/banks/NG`,
        {
          headers: {
            'Authorization': `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (response.data.status === 'success') {
        const banks = response.data.data.map(bank => ({
          bank_code: bank.code,
          bank_name: bank.name,
          sort_order: bank.sort_order || 0,
          is_active: true
        }));

        // Cache in database
        await supabase
          .from('flutterwave_banks')
          .upsert(banks, { onConflict: 'bank_code' });

        res.json({
          success: true,
          banks: banks,
          source: 'api'
        });
      } else {
        throw new Error('Failed to fetch banks');
      }
    } catch (error) {
      console.error('Banks fetch error:', error);
      
      // Fallback to cached banks
      const { data: fallback } = await supabase
        .from('flutterwave_banks')
        .select('*')
        .eq('is_active', true)
        .order('sort_order', { ascending: true });

      if (fallback && fallback.length > 0) {
        return res.json({
          success: true,
          banks: fallback,
          source: 'fallback'
        });
      }

      res.status(500).json({
        error: 'Failed to fetch banks',
        code: 'BANK_FETCH_FAILED'
      });
    }
  }
);

// ============================================================
// VERIFY ACCOUNT - RESOLVE ACCOUNT NAME
// ============================================================

app.post(
  '/api/flutterwave/verify-account',
  authenticate,
  checkAccountFrozen,
  async (req, res) => {
    try {
      const { bank_code, account_number } = req.body;

      if (!bank_code || !account_number) {
        return res.status(400).json({
          error: 'Bank code and account number required',
          code: 'MISSING_FIELDS'
        });
      }

      // Validate account number format (10 digits for Nigeria)
      if (!/^\d{10}$/.test(account_number)) {
        return res.status(400).json({
          error: 'Invalid account number format',
          code: 'INVALID_ACCOUNT_NUMBER',
          message: 'Account number must be 10 digits'
        });
      }

      // Call Flutterwave API to resolve account
      const response = await axios.post(
        `${process.env.FLUTTERWAVE_BASE_URL}/accounts/resolve`,
        {
          account_number: account_number,
          account_bank: bank_code
        },
        {
          headers: {
            'Authorization': `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (response.data.status === 'success') {
        const accountData = response.data.data;
        
        res.json({
          success: true,
          account_name: accountData.account_name,
          account_number: accountData.account_number,
          bank_code: bank_code,
          verified: true
        });
      } else {
        throw new Error(response.data.message || 'Verification failed');
      }
    } catch (error) {
      console.error('Account verification error:', error);

      // Handle specific Flutterwave errors
      if (error.response?.data?.status === 'error') {
        const message = error.response.data.message;
        if (message.includes('Invalid account number')) {
          return res.status(400).json({
            error: 'Invalid account number',
            code: 'INVALID_ACCOUNT',
            message: 'Please check the account number and try again'
          });
        }
        if (message.includes('Invalid bank code')) {
          return res.status(400).json({
            error: 'Invalid bank code',
            code: 'INVALID_BANK',
            message: 'Please select a valid bank'
          });
        }
        if (message.includes('Account not found')) {
          return res.status(404).json({
            error: 'Account not found',
            code: 'ACCOUNT_NOT_FOUND',
            message: 'No account found with these details'
          });
        }
      }

      res.status(500).json({
        error: 'Verification failed',
        code: 'VERIFICATION_FAILED',
        message: error.message || 'Please try again later'
      });
    }
  }
);

// ============================================================
// INITIATE FLUTTERWAVE TRANSFER
// ============================================================

app.post(
  '/api/flutterwave/transfer',
  authenticate,
  checkAccountFrozen,
  preventConcurrentTransfer,
  releaseTransactionLock,
  async (req, res) => {
    const {
      account_number,
      bank_code,
      bank_name,
      amount,
      narration,
      beneficiary_name,
      idempotency_key
    } = req.body;

    const requestId = req.headers['x-request-id'] || crypto.randomUUID();

    try {
      // ============================================================
      // 1. VALIDATE INPUT
      // ============================================================
      if (!account_number || !bank_code || !amount || !beneficiary_name) {
        return res.status(400).json({
          error: 'Missing required fields',
          code: 'MISSING_FIELDS',
          required: ['account_number', 'bank_code', 'amount', 'beneficiary_name']
        });
      }

      if (!/^\d{10}$/.test(account_number)) {
        return res.status(400).json({
          error: 'Invalid account number format',
          code: 'INVALID_ACCOUNT_NUMBER'
        });
      }

      if (amount <= 0) {
        return res.status(400).json({
          error: 'Invalid amount',
          code: 'INVALID_AMOUNT'
        });
      }

      // ============================================================
      // 2. CHECK IDEMPOTENCY
      // ============================================================
      if (idempotency_key) {
        const { data: existing } = await supabase
          .from('flutterware_idempotency_keys')
          .select('transfer_id, status, response')
          .eq('key', idempotency_key)
          .eq('user_id', req.user.id)
          .single();

        if (existing && existing.status === 'completed') {
          return res.json(existing.response);
        }
      }

      // ============================================================
      // 3. VALIDATE LIMITS
      // ============================================================
      const limits = await validateUserTransferLimits(req.user.id, amount);

      if (!limits.allowed) {
        return res.status(400).json({
          error: limits.reason,
          code: limits.code,
          limit: limits.limit,
          used: limits.used,
          remaining: limits.remaining
        });
      }

      // ============================================================
      // 4. GET USER ACCOUNT WITH LOCKING
      // ============================================================
      const { data: account, error: accError } = await supabase
        .from('accounts')
        .select('*')
        .eq('user_id', req.user.id)
        .eq('account_type', 'checking')
        .single();

      if (accError || !account) {
        return res.status(404).json({
          error: 'Account not found',
          code: 'ACCOUNT_NOT_FOUND'
        });
      }

      // ============================================================
      // 5. CALCULATE FEES
      // ============================================================
      const feePercentage = await getTransferFeePercentage();
      const feeAmount = amount * (feePercentage / 100);
      const totalDeduction = amount + feeAmount;

      // ============================================================
      // 6. CHECK AVAILABLE BALANCE
      // ============================================================
      const availableBalance = account.available_balance - account.reserved_balance;
      
      if (availableBalance < totalDeduction) {
        return res.status(400).json({
          error: 'Insufficient balance',
          code: 'INSUFFICIENT_BALANCE',
          available: availableBalance,
          required: totalDeduction
        });
      }

      // ============================================================
      // 7. START DATABASE TRANSACTION
      // ============================================================
      const { data: result, error: txError } = await supabase
        .rpc('begin_transaction');

      try {
        // 7a. LOCK ACCOUNT
        const { data: lockedAccount, error: lockError } = await supabase
          .from('accounts')
          .select('*')
          .eq('id', account.id)
          .eq('user_id', req.user.id)
          .single();

        if (lockError) throw lockError;

        // 7b. RESERVE FUNDS
        const newReserved = (lockedAccount.reserved_balance || 0) + totalDeduction;
        const newAvailable = lockedAccount.available_balance - totalDeduction;

        const { error: updateError } = await supabase
          .from('accounts')
          .update({
            reserved_balance: newReserved,
            available_balance: newAvailable,
            updated_at: new Date().toISOString()
          })
          .eq('id', lockedAccount.id);

        if (updateError) throw updateError;

        // 7c. GENERATE TRANSACTION REFERENCE
        const transactionReference = generateTransferReference();
        const transferId = crypto.randomUUID();

        // 7d. CREATE TRANSFER RECORD
        const { data: transfer, error: transferError } = await supabase
          .from('flutterwave_transfers')
          .insert({
            id: transferId,
            user_id: req.user.id,
            from_account_id: lockedAccount.id,
            amount: amount,
            currency: 'NGN',
            narration: narration || `Transfer to ${beneficiary_name}`,
            transaction_reference: transactionReference,
            idempotency_key: idempotency_key,
            beneficiary_name: beneficiary_name,
            bank_code: bank_code,
            bank_name: bank_name,
            account_number: account_number,
            fee_amount: feeAmount,
            total_deducted: totalDeduction,
            status: 'initiated',
            balance_before: lockedAccount.balance,
            balance_after: lockedAccount.balance - totalDeduction,
            reserved_before: lockedAccount.reserved_balance || 0,
            reserved_after: newReserved,
            initiated_at: new Date().toISOString(),
            ip_address: req.ip,
            user_agent: req.headers['user-agent'],
            device_fingerprint: req.headers['x-device-fingerprint'],
            created_by: req.user.id,
            request_id: requestId
          })
          .select()
          .single();

        if (transferError) throw transferError;

        // 7e. CREATE LEDGER ENTRIES
        await createTransferLedgerEntries({
          transfer: transfer,
          account: lockedAccount,
          amount: amount,
          feeAmount: feeAmount,
          totalDeduction: totalDeduction
        });

        // 7f. COMMIT TRANSACTION
        await supabase.rpc('commit_transaction');

        // ============================================================
        // 8. STORE IDEMPOTENCY
        // ============================================================
        if (idempotency_key) {
          await supabase
            .from('flutterwave_idempotency_keys')
            .insert({
              key: idempotency_key,
              request_id: requestId,
              user_id: req.user.id,
              transfer_id: transferId,
              status: 'pending',
              created_at: new Date().toISOString()
            });
        }

        // ============================================================
        // 9. UPDATE LIMITS
        // ============================================================
        await updateUserTransferLimits(req.user.id, totalDeduction);

        // ============================================================
        // 10. CALL FLUTTERWAVE API (ASYNC)
        // ============================================================
        // Send to Flutterwave (fire and forget)
        processFlutterwaveTransfer(transfer, {
          amount,
          narration,
          beneficiary_name,
          account_number,
          bank_code,
          transactionReference
        });

        // ============================================================
        // 11. CREATE NOTIFICATION
        // ============================================================
        await supabase
          .from('notifications')
          .insert({
            user_id: req.user.id,
            title: 'External Transfer Initiated',
            message: `Your transfer of ₦${amount.toLocaleString()} to ${beneficiary_name} has been initiated.`,
            type: 'info',
            created_at: new Date().toISOString()
          });

        // ============================================================
        // 12. RETURN RESPONSE
        // ============================================================
        res.json({
          success: true,
          message: 'Transfer initiated successfully',
          data: {
            transfer_id: transferId,
            transaction_reference: transactionReference,
            amount: amount,
            fee: feeAmount,
            total_deducted: totalDeduction,
            beneficiary_name: beneficiary_name,
            bank_name: bank_name,
            account_number: account_number,
            status: 'pending',
            new_available_balance: newAvailable,
            new_reserved_balance: newReserved,
            estimated_completion: '2-3 minutes'
          }
        });

      } catch (error) {
        // ROLLBACK ON ERROR
        await supabase.rpc('rollback_transaction');
        throw error;
      }

    } catch (error) {
      console.error('Transfer error:', error);
      
      res.status(500).json({
        error: 'Transfer failed',
        code: 'TRANSFER_FAILED',
        message: error.message
      });
    }
  }
);

// ============================================================
// HELPER FUNCTIONS
// ============================================================

function generateTransferReference() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const random = Math.random().toString(36).substring(2, 10).toUpperCase();
  return `FEE-${year}${month}${day}-${random}`;
}

async function validateUserTransferLimits(userId, amount) {
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];

  // Get or create user limits
  const { data: limits, error } = await supabase
    .from('flutterwave_transfer_limits')
    .select('*')
    .eq('user_id', userId)
    .single();

  if (error && error.code === 'PGRST116') {
    // Create default limits
    const { data: newLimits } = await supabase
      .from('flutterwave_transfer_limits')
      .insert({
        user_id: userId,
        daily_limit: 500000,
        monthly_limit: 5000000,
        single_transaction_limit: 1000000,
        daily_reset_date: todayStr,
        monthly_reset_date: todayStr
      })
      .select()
      .single();
    
    return validateLimits(newLimits, amount, todayStr);
  }

  if (error) throw error;

  return validateLimits(limits, amount, todayStr);
}

function validateLimits(limits, amount, todayStr) {
  // Check single transaction limit
  if (amount > limits.single_transaction_limit) {
    return {
      allowed: false,
      code: 'SINGLE_LIMIT_EXCEEDED',
      reason: `Single transaction limit is ₦${limits.single_transaction_limit.toLocaleString()}`,
      limit: limits.single_transaction_limit
    };
  }

  // Check daily limit
  if (limits.daily_reset_date !== todayStr) {
    limits.daily_used = 0;
    limits.daily_reset_date = todayStr;
  }

  if (limits.daily_used + amount > limits.daily_limit) {
    return {
      allowed: false,
      code: 'DAILY_LIMIT_EXCEEDED',
      reason: `Daily transfer limit is ₦${limits.daily_limit.toLocaleString()}`,
      limit: limits.daily_limit,
      used: limits.daily_used,
      remaining: limits.daily_limit - limits.daily_used
    };
  }

  // Check monthly limit
  const monthStr = todayStr.substring(0, 7);
  if (limits.monthly_reset_date.substring(0, 7) !== monthStr) {
    limits.monthly_used = 0;
    limits.monthly_reset_date = todayStr;
  }

  if (limits.monthly_used + amount > limits.monthly_limit) {
    return {
      allowed: false,
      code: 'MONTHLY_LIMIT_EXCEEDED',
      reason: `Monthly transfer limit is ₦${limits.monthly_limit.toLocaleString()}`,
      limit: limits.monthly_limit,
      used: limits.monthly_used,
      remaining: limits.monthly_limit - limits.monthly_used
    };
  }

  return {
    allowed: true,
    daily_remaining: limits.daily_limit - limits.daily_used - amount,
    monthly_remaining: limits.monthly_limit - limits.monthly_used - amount
  };
}

async function updateUserTransferLimits(userId, amount) {
  const today = new Date().toISOString().split('T')[0];
  const monthStr = today.substring(0, 7);

  await supabase
    .from('flutterwave_transfer_limits')
    .update({
      daily_used: supabase.raw('daily_used + ?', amount),
      monthly_used: supabase.raw('monthly_used + ?', amount),
      daily_reset_date: today,
      monthly_reset_date: today,
      last_updated_at: new Date().toISOString()
    })
    .eq('user_id', userId);
}

async function processFlutterwaveTransfer(transfer, details) {
  try {
    // Call Flutterwave API
    const response = await axios.post(
      `${process.env.FLUTTERWAVE_BASE_URL}/transfers`,
      {
        account_bank: details.bank_code,
        account_number: details.account_number,
        amount: details.amount,
        narration: details.narration || `Transfer to ${details.beneficiary_name}`,
        currency: 'NGN',
        reference: details.transactionReference,
        callback_url: `${process.env.FLUTTERWAVE_WEBHOOK_URL}`,
        beneficiary_name: details.beneficiary_name,
        debit_currency: 'NGN'
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    // Update transfer with Flutterwave response
    await supabase
      .from('flutterwave_transfers')
      .update({
        flutterwave_reference: response.data.data.id,
        flutterwave_status: response.data.data.status,
        status: response.data.data.status === 'NEW' ? 'pending' : 'processing',
        processed_at: new Date().toISOString()
      })
      .eq('id', transfer.id);

  } catch (error) {
    console.error('Flutterwave API error:', error);
    
    // Update transfer as failed
    await supabase
      .from('flutterwave_transfers')
      .update({
        status: 'failed',
        failure_reason: error.response?.data?.message || error.message,
        failure_code: error.response?.data?.code || 'API_ERROR',
        failed_at: new Date().toISOString()
      })
      .eq('id', transfer.id);

    // Release reserved funds
    await releaseReservedFunds(transfer.user_id, transfer.total_deducted);
  }
}

async function releaseReservedFunds(userId, amount) {
  const { data: account } = await supabase
    .from('accounts')
    .select('*')
    .eq('user_id', userId)
    .eq('account_type', 'checking')
    .single();

  if (account) {
    await supabase
      .from('accounts')
      .update({
        reserved_balance: (account.reserved_balance || 0) - amount,
        available_balance: account.available_balance + amount,
        updated_at: new Date().toISOString()
      })
      .eq('id', account.id);
  }
}
// Enhanced transfer with device trust and recipient checking - WITH EARLY FAILURE RECORDING
app.post(
  "/api/user/transfer",
  authenticate,
  checkAccountFrozen,
  transferLimiter,
  async (req, res) => {
    let failedRecordId = null;
    
    try {
      const {
        from_account_id,
        to_account_number,
        amount,
        description,
        device_fingerprint,
        skip_security_check = false,
        requires_otp = false
      } = req.body;

      // Get user agent and IP for logging
      const userAgent = req.headers['user-agent'];
      const ip = req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for'];

      // ========== STEP 1: CREATE INITIAL FAILED RECORD (in case anything fails) ==========
      const initialRecord = await createInitialFailedTransactionRecord(
        req.user.id, from_account_id, to_account_number, amount, description, ip, userAgent
      );
      if (initialRecord) {
        failedRecordId = initialRecord.id;
      }

      // ========== VALIDATION CHECKS ==========
      
      // Validate amount
      if (!amount || amount <= 0) {
        if (failedRecordId) {
          await updateFailedTransactionRecord(failedRecordId, "Invalid amount", "validation_error");
        }
        return res.status(400).json({ error: "Invalid amount" });
      }

      // Get source account
      const { data: fromAccount, error: fromError } = await supabase
        .from("accounts")
        .select("*, users!inner(id, email, first_name, last_name, phone)")
        .eq("id", from_account_id)
        .eq("user_id", req.user.id)
        .single();

      if (fromError || !fromAccount) {
        if (failedRecordId) {
          await updateFailedTransactionRecord(failedRecordId, "Source account not found", "account_error");
        }
        return res.status(404).json({ error: "Source account not found" });
      }

      // Check balance
      if (fromAccount.available_balance < amount) {
        if (failedRecordId) {
          await updateFailedTransactionRecord(
            failedRecordId, 
            "Insufficient funds", 
            "balance_error",
            { available_balance: fromAccount.available_balance, amount: amount }
          );
        }
        return res.status(400).json({ 
          error: "Insufficient funds",
          failed_record_id: failedRecordId
        });
      }

      // Get destination account
      const { data: toAccount, error: toError } = await supabase
        .from("accounts")
        .select("*, users!inner(id, email, first_name, last_name, is_frozen)")
        .eq("account_number", to_account_number)
        .single();

      if (toError || !toAccount) {
        if (failedRecordId) {
          await updateFailedTransactionRecord(failedRecordId, "Destination account not found", "account_error");
        }
        return res.status(404).json({ error: "Destination account not found" });
      }
      
      // Update the failed record with correct to_account_id and to_user_id
      if (failedRecordId) {
        await supabase
          .from("transactions")
          .update({
            to_account_id: toAccount.id,
            to_user_id: toAccount.user_id
          })
          .eq("id", failedRecordId);
      }

      // Prevent self-transfer
      if (toAccount.user_id === req.user.id) {
        if (failedRecordId) {
          await updateFailedTransactionRecord(failedRecordId, "Cannot transfer to own account", "validation_error");
        }
        return res.status(400).json({ error: "Cannot transfer to your own account" });
      }

      // Check if destination account is frozen
      if (toAccount.users?.is_frozen) {
        if (failedRecordId) {
          await updateFailedTransactionRecord(failedRecordId, "Destination account frozen", "account_frozen");
        }
        return res.status(400).json({ error: "Destination account is frozen" });
      }

      // ========== SECURITY CHECKS ==========
      
      // 1. Update device trust tracking
      const deviceTrust = await updateDeviceTrust(
        req.user.id,
        device_fingerprint || req.headers["user-agent"],
        req.headers["user-agent"],
        req.ip
      );
      
      // 2. Get user's current transfer threshold
      const userThreshold = await getUserTransferThreshold(
        req.user.id,
        device_fingerprint || req.headers["user-agent"]
      );
      
      // 3. Check if this is a large transfer (over ₦200,000)
      const isLargeTransfer = amount > 200000;
      
      // 4. Check if recipient is new (first time transfer)
      const isNewRecipient = !(await hasTransferredToBefore(req.user.id, to_account_number));
      
      // 5. Check if amount exceeds device threshold
      const exceedsThreshold = amount > userThreshold.threshold;
      
      // ========== SECURITY RESPONSES WITH FAILURE RECORDING ==========
      
      // Case 1: New device with amount above threshold
      if (!skip_security_check && exceedsThreshold && userThreshold.reason === "new_device") {
        if (failedRecordId) {
          await updateFailedTransactionRecord(
            failedRecordId, 
            `New device limit: ₦${userThreshold.threshold.toLocaleString()}`, 
            "security_new_device",
            { threshold: userThreshold.threshold, device_age: userThreshold.deviceAge }
          );
        }
        
        return res.status(403).json({
          error: "new_device_limit",
          message: `This device is not yet trusted. For security, transfers are limited to ₦${userThreshold.threshold.toLocaleString()} on new devices.`,
          threshold: userThreshold.threshold,
          device_age: userThreshold.deviceAge,
          required_days: 2 - (userThreshold.deviceAge || 0),
          reason: "new_device",
          failed_record_id: failedRecordId
        });
      }
      
      // Case 2: New recipient - require confirmation (not a failure yet)
      if (!skip_security_check && isNewRecipient) {
        // This is not a failure, just pending confirmation
        if (failedRecordId) {
          await updateFailedTransactionRecord(failedRecordId, "Awaiting new recipient confirmation", "pending_confirmation");
        }
        
        return res.status(403).json({
          error: "new_recipient",
          message: "You haven't transferred to this recipient before. Please verify their details carefully.",
          recipient: {
            name: `${toAccount.users?.first_name || ""} ${toAccount.users?.last_name || ""}`.trim(),
            account_number: to_account_number
          },
          require_confirmation: true,
          failed_record_id: failedRecordId
        });
      }
      
      // Case 3: Large transfer - require confirmation
      if (!skip_security_check && isLargeTransfer) {
        if (failedRecordId) {
          await updateFailedTransactionRecord(failedRecordId, "Awaiting large transfer confirmation", "pending_confirmation");
        }
        
        return res.status(403).json({
          error: "large_transfer",
          message: `You are about to transfer ₦${amount.toLocaleString()}. Please verify the recipient details carefully to avoid errors.`,
          recipient: {
            name: `${toAccount.users?.first_name || ""} ${toAccount.users?.last_name || ""}`.trim(),
            account_number: to_account_number
          },
          amount: amount,
          require_confirmation: true,
          failed_record_id: failedRecordId
        });
      }
      
      // ========== CONTINUE WITH NORMAL TRANSFER PROCESSING ==========
      
      // If we get here, delete the failed record since transfer will succeed
      if (failedRecordId) {
        await supabase.from("transactions").delete().eq("id", failedRecordId);
        failedRecordId = null;
      }
      
      // Calculate fee
      let feeAmount = 0;
      if (amount >= 10000) {
        feeAmount = 50;
      }

      const totalDeduction = amount + feeAmount;

      // Final balance check
      if (fromAccount.available_balance < totalDeduction) {
        // Re-create failed record since balance check failed
        const newFailedRecord = await createInitialFailedTransactionRecord(
          req.user.id, from_account_id, to_account_number, amount, description, ip, userAgent
        );
        if (newFailedRecord) {
          await updateFailedTransactionRecord(
            newFailedRecord.id, 
            "Insufficient funds after fee calculation", 
            "balance_error",
            { available_balance: fromAccount.available_balance, amount: totalDeduction }
          );
        }
        return res.status(400).json({
          error: `Insufficient funds. Amount: ₦${amount} + Fee: ₦${feeAmount} = ₦${totalDeduction}`,
        });
      }

      // Generate transaction ID
      const transactionId = `TXN${Date.now()}${Math.floor(Math.random() * 10000)}`;

      // Create transaction record
      const transactionData = {
        transaction_id: transactionId,
        from_account_id,
        to_account_id: toAccount.id,
        from_user_id: req.user.id,
        to_user_id: toAccount.user_id,
        amount: amount,
        fee_amount: feeAmount,
        description: description || `Transfer to ${toAccount.account_number}`,
        transaction_type: "transfer",
        status: "pending",
        created_at: new Date().toISOString(),
      };

      // Check for OTP requirement
      const isLargeAmount = amount > 500000;
      const needsOTP = requires_otp || isLargeAmount;

      if (needsOTP && process.env.OTP_MODE === "on") {
        transactionData.requires_otp = true;

        const { data: transaction, error: txError } = await supabase
          .from("transactions")
          .insert(transactionData)
          .select()
          .single();

        if (txError) throw txError;

        const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

        await supabase.from("otps").insert({
          user_id: req.user.id,
          transaction_id: transaction.id,
          otp_code: otpCode,
          otp_type: "transfer",
          expires_at: expiresAt,
        });

        await sendOTPEmail(fromAccount.users.email, otpCode);

        return res.json({
          message: "OTP required to complete transfer",
          requires_otp: true,
          transaction_id: transaction.id,
        });
      }

      // Process transfer immediately
      transactionData.status = "completed";
      transactionData.completed_at = new Date().toISOString();

      const { data: transaction, error: txError } = await supabase
        .from("transactions")
        .insert(transactionData)
        .select()
        .single();

      if (txError) throw txError;

      // Update balances
      const newSenderBalance = fromAccount.balance - totalDeduction;
      const newSenderAvailable = fromAccount.available_balance - totalDeduction;

      await supabase
        .from("accounts")
        .update({
          balance: newSenderBalance,
          available_balance: newSenderAvailable,
          updated_at: new Date().toISOString(),
        })
        .eq("id", from_account_id);

      const newReceiverBalance = toAccount.balance + amount;
      const newReceiverAvailable = toAccount.available_balance + amount;

      await supabase
        .from("accounts")
        .update({
          balance: newReceiverBalance,
          available_balance: newReceiverAvailable,
          updated_at: new Date().toISOString(),
        })
        .eq("id", toAccount.id);

      // Create notifications
      await createNotification(
        req.user.id,
        "Transfer Completed",
        `You transferred ₦${amount.toLocaleString()} to ${toAccount.account_number}. Fee: ₦${feeAmount}`,
        "success",
      );
      
      await createNotification(
        toAccount.user_id,
        "Money Received",
        `You received ₦${amount.toLocaleString()} from ${fromAccount.users.first_name} ${fromAccount.users.last_name}`,
        "success",
      );

      // Log successful transfer
      await logSecurityEvent(req.user.id, "transfer_completed", {
        amount,
        to_account: toAccount.account_number,
        transaction_id: transaction.id,
      });

      res.json({
        message: "Transfer completed successfully",
        transaction: {
          id: transaction.id,
          transaction_id: transaction.transaction_id,
          amount: amount,
          fee: feeAmount,
          total_deducted: totalDeduction,
          new_balance: newSenderAvailable,
          description: transaction.description,
          completed_at: transaction.completed_at,
        },
        recipient: {
          name: `${toAccount.users?.first_name || ""} ${toAccount.users?.last_name || ""}`.trim(),
          account_number: toAccount.account_number,
        },
      });
      
    } catch (error) {
      console.error("Transfer error:", error);
      
      // Update the failed record if it exists
      if (failedRecordId) {
        await updateFailedTransactionRecord(
          failedRecordId, 
          error.message || "Internal server error", 
          "server_error"
        );
      } else {
        // Create a new failed record
        const newFailedRecord = await createInitialFailedTransactionRecord(
          req.user.id, 
          req.body.from_account_id, 
          req.body.to_account_number, 
          req.body.amount, 
          req.body.description,
          req.ip,
          req.headers['user-agent']
        );
        if (newFailedRecord) {
          await updateFailedTransactionRecord(
            newFailedRecord.id, 
            error.message || "Internal server error", 
            "server_error"
          );
        }
      }
      
      await logSecurityEvent(req.user.id, "transfer_failed", {
        error: error.message,
      });
      res.status(500).json({ error: "Transfer failed: " + error.message });
    }
  }
);
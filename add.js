// Transfer money - COMPLETE FIXED VERSION with correct fee calculation
app.post(
  "/api/user/transfer",
  authenticate,
  checkAccountFrozen,
  async (req, res) => {
    try {
      const {
        from_account_id,
        to_account_number,
        amount,
        description,
        requires_otp = true,
      } = req.body;

      console.log("=== TRANSFER REQUEST ===");
      console.log("From Account:", from_account_id);
      console.log("To Account Number:", to_account_number);
      console.log("Amount:", amount);
      console.log("User ID:", req.user.id);

      // Validate amount
      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Invalid amount" });
      }

      // Check if OTP is required globally
      const { data: settings } = await supabase
        .from("admin_settings")
        .select("setting_value")
        .eq("setting_key", "otp_mode")
        .single();

      const otpMode = settings?.setting_value === "on";

      // Get source account
      const { data: fromAccount, error: fromError } = await supabase
        .from("accounts")
        .select("*")
        .eq("id", from_account_id)
        .eq("user_id", req.user.id)
        .single();

      if (fromError || !fromAccount) {
        console.error("Source account error:", fromError);
        return res.status(404).json({ error: "Source account not found" });
      }

      console.log("Source account balance:", fromAccount.available_balance);

      // Check balance
      if (fromAccount.available_balance < amount) {
        return res.status(400).json({ error: "Insufficient funds" });
      }

      // Get destination account
      const { data: toAccount, error: toError } = await supabase
        .from("accounts")
        .select("*, users!inner(id, first_name, last_name, email, is_frozen)")
        .eq("account_number", to_account_number)
        .single();

      if (toError || !toAccount) {
        console.error("Destination account error:", toError);
        return res.status(404).json({ error: "Destination account not found" });
      }

      console.log("Destination account found:", toAccount.account_number);

      // PREVENT SELF-TRANSFER
      if (toAccount.user_id === req.user.id) {
        return res.status(400).json({
          error:
            "Cannot transfer money to your own account. Please use a different recipient account.",
        });
      }

      // Check if destination account is frozen
      if (toAccount.users?.is_frozen) {
        return res.status(400).json({ error: "Destination account is frozen" });
      }

      // ==================== UPDATED FEE CALCULATION ====================
      // Fee rules:
      // - Transfers below ₦10,000: FREE (₦0)
      // - Transfers ₦10,000 and above: Flat fee of ₦50
      let feeAmount = 0;
      if (amount >= 10000) {
        feeAmount = 50; // Flat fee of ₦50 for any transfer ₦10,000 or above
      }
      // Transfers below ₦10,000 remain free (feeAmount = 0)
      
      const transferAmount = amount;
      const totalDeduction = transferAmount + feeAmount;

      console.log(`Fee calculation: Amount: ₦${amount}, Fee: ₦${feeAmount}, Total: ₦${totalDeduction}`);

      // Check balance with fee
      if (fromAccount.available_balance < totalDeduction) {
        return res.status(400).json({
          error: `Insufficient funds. Amount: ₦${amount.toFixed(2)} + Fee: ₦${feeAmount.toFixed(2)} = ₦${totalDeduction.toFixed(2)}`,
        });
      }

      // Generate transaction ID
      const transactionId = `TXN${Date.now()}${Math.floor(Math.random() * 1000)}`;

      // Create transaction record
      const transactionData = {
        transaction_id: transactionId,
        from_account_id,
        to_account_id: toAccount.id,
        from_user_id: req.user.id,
        to_user_id: toAccount.user_id,
        amount: transferAmount,
        fee_amount: feeAmount,
        description: description || `Transfer to ${toAccount.account_number}`,
        transaction_type: "transfer",
        status: "pending",
        created_at: new Date().toISOString(),
      };

      if (otpMode && requires_otp) {
        transactionData.requires_otp = true;

        const { data: transaction, error: txError } = await supabase
          .from("transactions")
          .insert(transactionData)
          .select()
          .single();

        if (txError) throw txError;

        // Generate OTP
        const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

        await supabase.from("otps").insert({
          user_id: req.user.id,
          transaction_id: transaction.id,
          otp_code: otpCode,
          otp_type: "transfer",
          expires_at: expiresAt,
        });

        // Send OTP via email (optional)
        try {
          const { data: user } = await supabase
            .from("users")
            .select("email")
            .eq("id", req.user.id)
            .single();

          if (user?.email) {
            await transporter.sendMail({
              from: process.env.SMTP_FROM,
              to: user.email,
              subject: "Your Transfer OTP Code",
              html: `<h2>OTP Code: ${otpCode}</h2><p>Use this code to complete your transfer of ₦${amount.toFixed(2)}.</p><p>Valid for 10 minutes.</p>`,
            });
          }
        } catch (emailError) {
          console.error("Failed to send OTP email:", emailError);
        }

        return res.json({
          message: "OTP required to complete transfer",
          requires_otp: true,
          transaction_id: transaction.id,
        });
      }

      // Process transfer immediately (no OTP required)
      transactionData.status = "completed";
      transactionData.completed_at = new Date().toISOString();

      const { data: transaction, error: txError } = await supabase
        .from("transactions")
        .insert(transactionData)
        .select()
        .single();

      if (txError) throw txError;

      // Update sender's balance
      const newSenderBalance = fromAccount.balance - totalDeduction;
      const newSenderAvailable = fromAccount.available_balance - totalDeduction;

      const { error: updateSenderError } = await supabase
        .from("accounts")
        .update({
          balance: newSenderBalance,
          available_balance: newSenderAvailable,
          updated_at: new Date().toISOString(),
        })
        .eq("id", from_account_id);

      if (updateSenderError) throw updateSenderError;

      // Update receiver's balance
      const newReceiverBalance = toAccount.balance + transferAmount;
      const newReceiverAvailable = toAccount.available_balance + transferAmount;

      const { error: updateReceiverError } = await supabase
        .from("accounts")
        .update({
          balance: newReceiverBalance,
          available_balance: newReceiverAvailable,
          updated_at: new Date().toISOString(),
        })
        .eq("id", toAccount.id);

      if (updateReceiverError) throw updateReceiverError;

      // Process fee income if applicable
      if (feeAmount > 0) {
        await processFeeIncome(transaction, feeAmount, fromAccount, toAccount);
      }

      // ==================== LEDGER ENTRIES ====================

      // Process double-entry for transfer
      await processDoubleEntry(
        transaction,
        req.user,
        fromAccount,
        toAccount,
        transferAmount,
        description,
        "transfer",
        feeAmount,
      );

      // Update single ledger for sender (Debit)
      await updateSingleLedger(
        fromAccount.id,
        req.user.id,
        totalDeduction,
        "transfer",
        `Transfer to ${toAccount.account_number} (${toAccount.users?.first_name || ""} ${toAccount.users?.last_name || ""})`,
        "Debit",
        transaction.id,
      );

      // Update single ledger for receiver (Credit)
      await updateSingleLedger(
        toAccount.id,
        toAccount.user_id,
        transferAmount,
        "transfer",
        `Transfer from ${fromAccount.account_number} (${req.user.first_name} ${req.user.last_name})`,
        "Credit",
        transaction.id,
      );

      // Create notification for sender
      await supabase.from("notifications").insert({
        user_id: req.user.id,
        title: "Transfer Completed",
        message: `You have successfully transferred ₦${transferAmount.toFixed(2)} to account ${toAccount.account_number}.${feeAmount > 0 ? ` Fee: ₦${feeAmount.toFixed(2)}` : " No fee charged."}`,
        type: "success",
        created_at: new Date().toISOString(),
      });

      // Create notification for recipient
      await supabase.from("notifications").insert({
        user_id: toAccount.user_id,
        title: "Money Received",
        message: `You have received ₦${transferAmount.toFixed(2)} from ${req.user.first_name} ${req.user.last_name}`,
        type: "success",
        created_at: new Date().toISOString(),
      });

      // Log admin action for large transfers (over ₦1,000,000)
      if (amount > 1000000) {
        await supabase.from("admin_actions").insert({
          admin_id: null,
          action_type: "large_transfer",
          target_user_id: req.user.id,
          details: {
            amount,
            to_user: toAccount.user_id,
            transaction_id: transaction.id,
          },
          created_at: new Date().toISOString(),
        });
      }

      console.log("Transfer completed successfully:", transaction.id);

      res.json({
        message: "Transfer completed successfully",
        transaction: {
          id: transaction.id,
          transaction_id: transaction.transaction_id,
          amount: transferAmount,
          fee: feeAmount,
          total_deducted: totalDeduction,
          new_balance: newSenderAvailable,
          description: transaction.description,
          completed_at: transaction.completed_at,
        },
        recipient: {
          name: `${toAccount.users?.first_name || ""} ${toAccount.users?.last_name || ""}`,
          account_number: toAccount.account_number,
        },
      });
    } catch (error) {
      console.error("Transfer error:", error);
      res.status(500).json({ error: "Transfer failed: " + error.message });
    }
  },
);
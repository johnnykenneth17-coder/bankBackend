// Transfer money
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

      // Check if OTP is required globally
      const { data: settings } = await supabase
        .from("admin_settings")
        .select("setting_value")
        .eq("setting_key", "otp_mode")
        .single();

      const otpMode = settings?.setting_value === "on";

      // Get source account
      const { data: fromAccount } = await supabase
        .from("accounts")
        .select("*")
        .eq("id", from_account_id)
        .eq("user_id", req.user.id)
        .single();

      if (!fromAccount) {
        return res.status(404).json({ error: "Source account not found" });
      }

      // Check balance
      if (fromAccount.available_balance < amount) {
        return res.status(400).json({ error: "Insufficient funds" });
      }

      // Get destination account
      const { data: toAccount } = await supabase
        .from("accounts")
        .select("*")
        .eq("account_number", to_account_number)
        .single();

      if (!toAccount) {
        return res.status(404).json({ error: "Destination account not found" });
      }

      // ========== PREVENT SELF-TRANSFER ==========
      // Check if the destination account belongs to the same user
      if (toAccount.user_id === req.user.id) {
        return res.status(400).json({ 
          error: "Cannot transfer money to your own account. Please use a different recipient account." 
        });
      }
      // ============================================

      // Check if destination account is frozen
      const { data: toUser } = await supabase
        .from("users")
        .select("is_frozen")
        .eq("id", toAccount.user_id)
        .single();

      if (toUser?.is_frozen) {
        return res.status(400).json({ error: "Destination account is frozen" });
      }

      // Create transaction
      const transactionData = {
        from_account_id,
        to_account_id: toAccount.id,
        from_user_id: req.user.id,
        to_user_id: toAccount.user_id,
        amount,
        description,
        transaction_type: "transfer",
        status: "pending",
      };

      if (otpMode && requires_otp) {
        transactionData.requires_otp = true;
        // Generate OTP
        const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

        const { data: transaction, error } = await supabase
          .from("transactions")
          .insert(transactionData)
          .select()
          .single();

        if (error) throw error;

        await supabase.from("otps").insert({
          user_id: req.user.id,
          transaction_id: transaction.id,
          otp_code: otpCode,
          otp_type: "transfer",
          expires_at: expiresAt,
        });

        return res.json({
          message: "OTP required to complete transfer",
          requires_otp: true,
          transaction_id: transaction.id,
        });
      }

      // Process transfer immediately
      transactionData.status = "completed";
      transactionData.completed_at = new Date();

      const { data: transaction, error } = await supabase
        .from("transactions")
        .insert(transactionData)
        .select()
        .single();

      if (error) throw error;

      // Update balances
      await supabase
        .from("accounts")
        .update({
          balance: fromAccount.balance - amount,
          available_balance: fromAccount.available_balance - amount,
        })
        .eq("id", from_account_id);

      await supabase
        .from("accounts")
        .update({
          balance: toAccount.balance + amount,
          available_balance: toAccount.available_balance + amount,
        })
        .eq("id", toAccount.id);

      // Create notification for recipient
      await supabase.from("notifications").insert({
        user_id: toAccount.user_id,
        title: "Money Received",
        message: `You have received $${amount} from ${req.user.first_name} ${req.user.last_name}`,
        type: "success",
      });

      res.json({
        message: "Transfer completed successfully",
        transaction,
      });
    } catch (error) {
      console.error("Transfer error:", error);
      res.status(500).json({ error: "Transfer failed" });
    }
  },
);
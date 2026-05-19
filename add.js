// Get single transaction details for receipt viewing - UPDATED to handle failed transactions
app.get(
  "/api/user/transactions/:transactionId",
  authenticate,
  async (req, res) => {
    try {
      const { transactionId } = req.params;
      
      // Check if it's a numeric ID (database ID) or string ID
      let query;
      if (transactionId.match(/^\d+$/)) {
        // Numeric ID - query by database id
        query = supabase
          .from("transactions")
          .select(`
            *,
            from_account:accounts!transactions_from_account_id_fkey(id, account_number),
            to_account:accounts!transactions_to_account_id_fkey(id, account_number),
            from_user:users!transactions_from_user_id_fkey(id, first_name, last_name, email),
            to_user:users!transactions_to_user_id_fkey(id, first_name, last_name, email)
          `)
          .eq("id", parseInt(transactionId));
      } else {
        // String ID - query by transaction_id
        query = supabase
          .from("transactions")
          .select(`
            *,
            from_account:accounts!transactions_from_account_id_fkey(id, account_number),
            to_account:accounts!transactions_to_account_id_fkey(id, account_number),
            from_user:users!transactions_from_user_id_fkey(id, first_name, last_name, email),
            to_user:users!transactions_to_user_id_fkey(id, first_name, last_name, email)
          `)
          .eq("transaction_id", transactionId);
      }
      
      const { data: transaction, error } = await query.single();

      if (error) {
        console.error("Transaction fetch error:", error);
        return res.status(404).json({ error: "Transaction not found" });
      }

      // Verify user owns this transaction
      if (
        transaction.from_user_id !== req.user.id &&
        transaction.to_user_id !== req.user.id
      ) {
        return res.status(403).json({ error: "Access denied" });
      }

      res.json(transaction);
    } catch (error) {
      console.error("Transaction fetch error:", error);
      res.status(500).json({ error: "Failed to fetch transaction" });
    }
  }
);
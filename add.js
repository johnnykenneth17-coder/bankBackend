// Get single transaction details for receipt viewing
app.get(
  "/api/user/transactions/:transactionId",
  authenticate,
  async (req, res) => {
    try {
      const { transactionId } = req.params;
      
      const { data: transaction, error } = await supabase
        .from("transactions")
        .select(`
          *,
          from_account:accounts!transactions_from_account_id_fkey(id, account_number),
          to_account:accounts!transactions_to_account_id_fkey(id, account_number),
          from_user:users!transactions_from_user_id_fkey(id, first_name, last_name, email),
          to_user:users!transactions_to_user_id_fkey(id, first_name, last_name, email)
        `)
        .eq("id", transactionId)
        .single();
      
      if (error) throw error;
      
      // Verify user owns this transaction
      if (transaction.from_user_id !== req.user.id && transaction.to_user_id !== req.user.id) {
        return res.status(403).json({ error: "Access denied" });
      }
      
      res.json(transaction);
    } catch (error) {
      console.error("Transaction fetch error:", error);
      res.status(500).json({ error: "Failed to fetch transaction" });
    }
  }
);
// In index.js — add this route (preferably after auth routes)

// Get recipient name by account number (for transfer confirmation)
app.get("/api/accounts/recipient", authenticate, async (req, res) => {
  const { account_number } = req.query;

  if (!account_number || typeof account_number !== "string" || account_number.length < 8) {
    return res.status(400).json({ error: "Invalid account number format" });
  }

  try {
    const { data, error } = await supabase
      .from("accounts")
      .select(`
        id,
        account_number,
        user_id,
        users!inner (
          first_name,
          last_name
        )
      `)
      .eq("account_number", account_number)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: "Account not found" });
    }

    const fullName = `${data.users.first_name} ${data.users.last_name}`;

    res.json({
      success: true,
      name: fullName.trim(),
      account_id: data.id,           // optional — useful later
      user_id: data.user_id
    });
  } catch (err) {
    console.error("Recipient lookup error:", err);
    res.status(500).json({ error: "Failed to verify account" });
  }
});
// In index.js - Fix the createInitialFailedTransactionRecord function
async function createInitialFailedTransactionRecord(
  userId,
  fromAccountId,
  toAccountNumber,
  amount,
  description,
  ip,
  userAgent,
) {
  try {
    // Get the source account details
    const { data: fromAccount } = await supabase
      .from("accounts")
      .select("account_number, user_id")
      .eq("id", fromAccountId)
      .single();

    // Try to get destination account info if it exists
    let toAccountId = null;
    let toUserId = null;
    let toAccountNumberDisplay = toAccountNumber;

    const { data: toAccount } = await supabase
      .from("accounts")
      .select("id, user_id, account_number")
      .eq("account_number", toAccountNumber)
      .maybeSingle();

    if (toAccount) {
      toAccountId = toAccount.id;
      toUserId = toAccount.user_id;
      toAccountNumberDisplay = toAccount.account_number;
    }

    const transactionId = `FAIL${Date.now()}${Math.floor(Math.random() * 10000)}`;

    const transactionData = {
      transaction_id: transactionId,
      from_account_id: fromAccountId,
      to_account_id: toAccountId,
      from_user_id: userId,
      to_user_id: toUserId,
      amount: amount,
      fee_amount: 0,
      description: description || `Transfer to ${toAccountNumberDisplay}`,
      transaction_type: "transfer",
      status: "pending", // Use pending, not failed - we'll update to failed later
      failed_reason: null, // Start with null
      failure_type: null,
      created_at: new Date().toISOString(),
      ip_address: ip,
      user_agent: userAgent,
    };

    const { data: inserted, error } = await supabase
      .from("transactions")
      .insert(transactionData)
      .select()
      .single();

    if (error) {
      console.error("Failed to create initial record:", error);
      return null;
    }

    console.log(
      `📝 Created initial transaction record: ${transactionId}, Amount: ${amount}, Status: pending`,
    );
    return inserted;
  } catch (error) {
    console.error("Error creating initial record:", error);
    return null;
  }
}

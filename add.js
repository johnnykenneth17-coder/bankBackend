// In index.js - Fix createInitialFailedTransactionRecord
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
    const { data: fromAccount } = await supabase
      .from("accounts")
      .select("account_number, user_id")
      .eq("id", fromAccountId)
      .single();

    let toAccountId = null;
    let toUserId = null;

    const { data: toAccount } = await supabase
      .from("accounts")
      .select("id, user_id, account_number")
      .eq("account_number", toAccountNumber)
      .maybeSingle();

    if (toAccount) {
      toAccountId = toAccount.id;
      toUserId = toAccount.user_id;
    }

    const transactionId = `PEND${Date.now()}${Math.floor(Math.random() * 10000)}`;

    // IMPORTANT: Create as PENDING, not failed
    const { data: inserted, error } = await supabase
      .from("transactions")
      .insert({
        transaction_id: transactionId,
        from_account_id: fromAccountId,
        to_account_id: toAccountId,
        from_user_id: userId,
        to_user_id: toUserId,
        amount: amount,
        fee_amount: 0,
        description: description || `Transfer to ${toAccountNumber}`,
        transaction_type: "transfer",
        status: "pending", // PENDING, not failed
        failed_reason: null,
        failure_type: null,
        created_at: new Date().toISOString(),
        ip_address: ip,
        user_agent: userAgent,
      })
      .select()
      .single();

    if (error) {
      console.error("Failed to create initial record:", error);
      return null;
    }

    console.log(
      `📝 Created initial PENDING record: ${inserted.id} (${transactionId})`,
    );
    return inserted;
  } catch (error) {
    console.error("Error creating initial record:", error);
    return null;
  }
}

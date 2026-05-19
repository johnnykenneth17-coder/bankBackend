// In the transfer route, when balance check fails
if (fromAccount.available_balance < amount) {
  if (failedRecordId) {
    await updateFailedTransactionRecord(
      failedRecordId, 
      `Insufficient balance. Available: ₦${fromAccount.available_balance.toLocaleString()}, Required: ₦${amount.toLocaleString()}`, 
      "balance_error",
      { available_balance: fromAccount.available_balance, amount: amount }
    );
  }
  return res.status(400).json({ 
    error: "Insufficient funds",
    failed_record_id: failedRecordId,
    available_balance: fromAccount.available_balance,
    required_amount: amount
  });
}
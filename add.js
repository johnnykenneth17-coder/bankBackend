// In the transfer endpoint where you call updateFailedTransactionRecord
if (failedRecordId) {
  await updateFailedTransactionRecord(
    failedRecordId,
    failureReason,
    "balance_error",
    {
      available_balance: fromAccount.available_balance,
      amount: amount,
      user_id: req.user.id,  // ← Add this
    },
  );
}
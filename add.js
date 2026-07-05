// Add this method to FinancialTransactionService.js

/**
 * Check if a transaction has already been processed
 */
async checkTransactionIdempotency(requestId, userId, transactionType, referenceId) {
  if (!requestId) return null;

  const { data, error } = await this.supabase
    .from('idempotency_keys')
    .select('response')
    .eq('key', requestId)
    .eq('user_id', userId)
    .eq('status', 'completed')
    .single();

  if (error) return null;
  if (data) {
    console.log(`[Idempotency] Request ${requestId} already processed for user ${userId}`);
    return data.response;
  }
  return null;
}
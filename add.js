// ============================================================
// PATCH — index.js: REPLACE /api/sys/users/:userId/adjust-balance
// (currently starts at line 12875) with this version.
// Run migration_010_process_admin_balance_adjustment.sql first.
// ============================================================
//
// What changed vs your current version:
//   - No more `new FinancialTransactionService()` / `.executeTransaction()`
//     — that path can't guarantee atomicity (see prior review). Everything
//     it did (balance updates, ledger entries, audit log, notification)
//     now happens inside process_admin_balance_adjustment, in one
//     Postgres transaction with real FOR UPDATE locks.
//   - The admin_actions insert and notification insert that used to be
//     separate JS-level calls after the transaction are now inside the
//     same atomic RPC, so they can't end up out of sync with the ledger
//     (e.g. money moved but audit log insert silently failed).
//   - Everything else — input validation, response shape — is unchanged,
//     so no frontend changes are needed.










// ------------------------------------------------------------
// Cleanup — once this is deployed and verified:
//   1. Delete the dead-code duplicate `/api/user/savings/:type/:id/withdraw`
//      registrations at lines 10494 and 10794 (only the one at line 10271
//      ever runs; the other two — including the one still calling
//      transactionService.executeTransaction() — are unreachable but worth
//      removing so nobody edits them thinking they're live).
//   2. At that point nothing in index.js calls
//      transactionService.executeTransaction() anymore — delete
//      FinancialTransactionService.js and its `require`/instantiation.
// ------------------------------------------------------------
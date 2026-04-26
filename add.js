// Process transaction with double entry bookkeeping (UPDATED)
async function processDoubleEntry(transaction, user, fromAccount, toAccount, amount, description, transactionType, feeAmount = 0) {
    const results = [];
    const now = new Date();
    
    // Case 1: Transfer between customer accounts
    if (fromAccount && toAccount && fromAccount.user_id !== toAccount.user_id) {
        // Debit sender's customer liability account
        results.push({
            user_id: fromAccount.user_id,
            account_code: '2000', // Customer Liabilities
            account_name: 'Customer Liabilities',
            debit_amount: amount,
            credit_amount: 0,
            description: `Debit - Transfer to account ${toAccount.account_number}`,
            reference: transaction.transaction_id,
            entry_date: now,
            transaction_id: transaction.id,
            posted_by: null,
            posted_at: now,
            is_reconciled: false,
        });
        
        // Credit receiver's customer liability account
        results.push({
            user_id: toAccount.user_id,
            account_code: '2000', // Customer Liabilities
            account_name: 'Customer Liabilities',
            debit_amount: 0,
            credit_amount: amount,
            description: `Credit - Transfer from account ${fromAccount.account_number}`,
            reference: transaction.transaction_id,
            entry_date: now,
            transaction_id: transaction.id,
            posted_by: null,
            posted_at: now,
            is_reconciled: false,
        });
        
        // Record fee income if applicable
        if (feeAmount > 0) {
            // Debit settlement account for fee
            results.push({
                user_id: null,
                account_code: '1030', // Settlement Accounts
                account_name: 'Settlement Accounts',
                debit_amount: feeAmount,
                credit_amount: 0,
                description: `Fee settlement for transfer ${transaction.transaction_id}`,
                reference: transaction.transaction_id,
                entry_date: now,
                transaction_id: transaction.id,
                posted_by: null,
                posted_at: now,
                is_reconciled: false,
            });
            
            // Credit transfer fee revenue
            results.push({
                user_id: null,
                account_code: '4020', // Transfer Fees
                account_name: 'Transfer Fees',
                debit_amount: 0,
                credit_amount: feeAmount,
                description: `Transfer fee for transaction ${transaction.transaction_id}`,
                reference: transaction.transaction_id,
                entry_date: now,
                transaction_id: transaction.id,
                posted_by: null,
                posted_at: now,
                is_reconciled: false,
            });
        }
    }
    
    // Case 2: Deposit (User adding money)
    else if (toAccount && !fromAccount) {
        // Debit settlement account (money coming in)
        results.push({
            user_id: null,
            account_code: '1030', // Settlement Accounts
            account_name: 'Settlement Accounts',
            debit_amount: amount,
            credit_amount: 0,
            description: `Deposit from user ${user?.email || 'unknown'}`,
            reference: transaction.transaction_id,
            entry_date: now,
            transaction_id: transaction.id,
            posted_by: null,
            posted_at: now,
            is_reconciled: false,
        });
        
        // Credit customer liability (user's balance increases)
        results.push({
            user_id: user?.id,
            account_code: '2000', // Customer Liabilities
            account_name: 'Customer Liabilities',
            debit_amount: 0,
            credit_amount: amount,
            description: `Deposit to account ${toAccount.account_number}`,
            reference: transaction.transaction_id,
            entry_date: now,
            transaction_id: transaction.id,
            posted_by: null,
            posted_at: now,
            is_reconciled: false,
        });
    }
    
    // Case 3: Withdrawal
    else if (fromAccount && !toAccount) {
        // Debit customer liability (user's balance decreases)
        results.push({
            user_id: user?.id,
            account_code: '2000', // Customer Liabilities
            account_name: 'Customer Liabilities',
            debit_amount: amount,
            credit_amount: 0,
            description: `Withdrawal from account ${fromAccount.account_number}`,
            reference: transaction.transaction_id,
            entry_date: now,
            transaction_id: transaction.id,
            posted_by: null,
            posted_at: now,
            is_reconciled: false,
        });
        
        // Credit settlement account
        results.push({
            user_id: null,
            account_code: '1030', // Settlement Accounts
            account_name: 'Settlement Accounts',
            debit_amount: 0,
            credit_amount: amount,
            description: `Withdrawal payout for transaction ${transaction.transaction_id}`,
            reference: transaction.transaction_id,
            entry_date: now,
            transaction_id: transaction.id,
            posted_by: null,
            posted_at: now,
            is_reconciled: false,
        });
    }
    
    // Insert all ledger entries
    for (const entry of results) {
        const { error } = await supabase
            .from("general_ledger")
            .insert(entry);
        
        if (error) {
            console.error("Ledger entry error:", error);
        }
    }
    
    return results;
}
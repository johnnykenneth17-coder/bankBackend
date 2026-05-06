async function processSingleSaveboxDeduction(saving) {
    try {
        const dailyAmount = saving.daily_amount;
        
        if (!dailyAmount || dailyAmount <= 0) {
            console.error(`Invalid daily amount for savebox savings ${saving.id}`);
            return;
        }
        
        const { data: account, error: accError } = await supabase
            .from('accounts')
            .select('*')
            .eq('user_id', saving.user_id)
            .eq('account_type', 'checking')
            .single();
        
        if (accError || !account) {
            console.error(`No account for user ${saving.user_id}`);
            await addToRetryQueue(saving.user_id, saving.id, 'savebox', dailyAmount);
            return;
        }
        
        if (saving.users?.is_frozen) return;
        
        // Check if sufficient balance
        if (account.available_balance < dailyAmount) {
            console.log(`Insufficient balance for user ${saving.user_id} - adding to retry queue`);
            await addToRetryQueue(saving.user_id, saving.id, 'savebox', dailyAmount);
            await sendLowBalanceNotification(saving.users, 'SaveBox');
            return;
        }
        
        // Deduct the DAILY amount
        const newBalance = account.balance - dailyAmount;
        const newAvailable = account.available_balance - dailyAmount;
        
        await supabase
            .from('accounts')
            .update({ balance: newBalance, available_balance: newAvailable })
            .eq('id', account.id);
        
        const newCurrentSaved = (saving.current_saved || 0) + dailyAmount;
        const isCompleted = new Date() >= new Date(saving.target_date) || newCurrentSaved >= saving.amount;
        
        await supabase
            .from('savebox_savings')
            .update({
                current_saved: newCurrentSaved,
                last_deduction_date: new Date(),
                status: isCompleted ? 'completed' : 'active'
            })
            .eq('id', saving.id);
        
        // Create transaction
        await supabase.from('transactions').insert({
            from_account_id: account.id,
            from_user_id: saving.user_id,
            amount: dailyAmount,
            description: `SaveBox Savings - Target: ₦${saving.amount.toFixed(2)}`,
            transaction_type: 'savings',
            status: 'completed',
            completed_at: new Date()
        });
        
        // Create savings transaction
        await supabase.from('savings_transactions').insert({
            user_id: saving.user_id,
            savings_type: 'savebox',
            savings_id: saving.id,
            amount: dailyAmount,
            transaction_type: 'deposit',
            description: `Daily SaveBox deposit`
        });
        
        console.log(`Savebox deduction completed for user ${saving.user_id}: ₦${dailyAmount}`);
        
        if (isCompleted) {
            await sendSaveboxCompletionNotification(saving);
        }
        
    } catch (error) {
        console.error(`Savebox error for user ${saving.user_id}:`, error);
        await addToRetryQueue(saving.user_id, saving.id, 'savebox', saving.daily_amount);
    }
}
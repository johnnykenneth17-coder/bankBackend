// savings-cron.js - Server-side cron job for all savings processing
// This should be deployed as a separate serverless function or cron job

const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    secure: process.env.SMTP_PORT == 465,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
    },
});

// Main cron function - should run every hour
async function processAllSavings() {
    console.log(`[${new Date().toISOString()}] Starting savings processing...`);
    
    await processHarvestPlans();
    await processFixedSavings();
    await processSaveboxSavings();
    await processTargetSavings();
    await retryFailedDeductions();
    
    await sendDailyNotifications();
    
    console.log(`[${new Date().toISOString()}] Savings processing completed`);
}

// ==================== HARVEST PLANS ====================
async function processHarvestPlans() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // Get active harvest enrollments that need daily deduction
    const { data: enrollments, error } = await supabase
        .from('user_harvest_enrollments')
        .select(`
            *,
            users!inner(id, email, first_name, last_name, is_frozen),
            harvest_plans!inner(daily_amount, duration_days, name)
        `)
        .eq('status', 'active')
        .eq('auto_save', true)
        .lt('next_deduction_due', new Date().toISOString())
        .limit(100);
    
    if (error) {
        console.error('Harvest plans fetch error:', error);
        return;
    }
    
    for (const enrollment of enrollments || []) {
        await processSingleHarvestDeduction(enrollment);
    }
}

async function processSingleHarvestDeduction(enrollment) {
    try {
        // Get user's primary checking account
        const { data: account, error: accError } = await supabase
            .from('accounts')
            .select('*')
            .eq('user_id', enrollment.user_id)
            .eq('account_type', 'checking')
            .single();
        
        if (accError || !account) {
            console.error(`No account for user ${enrollment.user_id}`);
            await logFailedDeduction(enrollment.user_id, enrollment.id, 'harvest', enrollment.daily_amount);
            return;
        }
        
        // Check if user is frozen
        if (enrollment.users?.is_frozen) {
            console.log(`User ${enrollment.user_id} is frozen - pausing harvest deductions`);
            return;
        }
        
        // Check if sufficient balance
        if (account.available_balance < enrollment.daily_amount) {
            console.log(`Insufficient balance for user ${enrollment.user_id} - adding to retry queue`);
            await addToRetryQueue(enrollment.user_id, enrollment.id, 'harvest', enrollment.daily_amount);
            await sendLowBalanceNotification(enrollment.users, enrollment.harvest_plans?.name);
            return;
        }
        
        // Deduct amount
        const newBalance = account.balance - enrollment.daily_amount;
        const newAvailable = account.available_balance - enrollment.daily_amount;
        
        await supabase
            .from('accounts')
            .update({ balance: newBalance, available_balance: newAvailable })
            .eq('id', account.id);
        
        // Update enrollment
        const newTotalSaved = (enrollment.total_saved || 0) + enrollment.daily_amount;
        const newDaysCompleted = (enrollment.days_completed || 0) + 1;
        const isCompleted = newDaysCompleted >= enrollment.harvest_plans?.duration_days;
        
        const nextDeduction = new Date();
        nextDeduction.setDate(nextDeduction.getDate() + 1);
        
        await supabase
            .from('user_harvest_enrollments')
            .update({
                total_saved: newTotalSaved,
                days_completed: newDaysCompleted,
                last_deduction_date: new Date(),
                next_deduction_due: nextDeduction,
                status: isCompleted ? 'completed' : 'active',
                failed_deductions: 0
            })
            .eq('id', enrollment.id);
        
        // Create transaction record
        await supabase.from('transactions').insert({
            from_account_id: account.id,
            from_user_id: enrollment.user_id,
            amount: enrollment.daily_amount,
            description: `Harvest Plan: ${enrollment.harvest_plans?.name} - Day ${newDaysCompleted}`,
            transaction_type: 'savings',
            status: 'completed',
            completed_at: new Date(),
            is_admin_adjusted: false
        });
        
        // Create savings transaction
        await supabase.from('savings_transactions').insert({
            user_id: enrollment.user_id,
            savings_type: 'harvest',
            savings_id: enrollment.id,
            amount: enrollment.daily_amount,
            transaction_type: 'deposit',
            description: `Auto-save day ${newDaysCompleted}`
        });
        
        console.log(`Harvest deduction completed for user ${enrollment.user_id}: ₦${enrollment.daily_amount}`);
        
        // Send completion notification if completed
        if (isCompleted) {
            await sendHarvestCompletionNotification(enrollment);
        }
        
    } catch (error) {
        console.error(`Harvest deduction error for user ${enrollment.user_id}:`, error);
        await logFailedDeduction(enrollment.user_id, enrollment.id, 'harvest', enrollment.daily_amount);
    }
}

// ==================== FIXED SAVINGS ====================
async function processFixedSavings() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const { data: savings, error } = await supabase
        .from('fixed_savings')
        .select(`
            *,
            users!inner(id, email, first_name, last_name, is_frozen)
        `)
        .eq('status', 'active')
        .eq('auto_save', true)
        .lt('last_deduction_date', today.toISOString())
        .limit(100);
    
    if (error) {
        console.error('Fixed savings fetch error:', error);
        return;
    }
    
    for (const saving of savings || []) {
        await processSingleFixedDeduction(saving);
    }
}

async function processSingleFixedDeduction(saving) {
    try {
        const dailyAmount = saving.daily_amount || 1000; // Default daily amount
        
        // Get user's account
        const { data: account, error: accError } = await supabase
            .from('accounts')
            .select('*')
            .eq('user_id', saving.user_id)
            .eq('account_type', 'checking')
            .single();
        
        if (accError || !account) {
            console.error(`No account for user ${saving.user_id}`);
            return;
        }
        
        if (saving.users?.is_frozen) return;
        
        if (account.available_balance < dailyAmount) {
            await addToRetryQueue(saving.user_id, saving.id, 'fixed', dailyAmount);
            await sendLowBalanceNotification(saving.users, 'Fixed Savings');
            return;
        }
        
        // Deduct amount
        const newBalance = account.balance - dailyAmount;
        const newAvailable = account.available_balance - dailyAmount;
        
        await supabase
            .from('accounts')
            .update({ balance: newBalance, available_balance: newAvailable })
            .eq('id', account.id);
        
        // Update savings record
        const newCurrentSaved = (saving.current_saved || 0) + dailyAmount;
        const isMatured = new Date() >= new Date(saving.maturity_date);
        
        await supabase
            .from('fixed_savings')
            .update({
                current_saved: newCurrentSaved,
                last_deduction_date: new Date(),
                status: isMatured ? 'matured' : 'active'
            })
            .eq('id', saving.id);
        
        // Create transaction
        await supabase.from('transactions').insert({
            from_account_id: account.id,
            from_user_id: saving.user_id,
            amount: dailyAmount,
            description: `Fixed Savings Deposit - Matures: ${new Date(saving.maturity_date).toLocaleDateString()}`,
            transaction_type: 'savings',
            status: 'completed',
            completed_at: new Date()
        });
        
        console.log(`Fixed savings deduction completed for user ${saving.user_id}: ₦${dailyAmount}`);
        
        // Check if matured
        if (isMatured) {
            await sendFixedMaturityNotification(saving);
        }
        
    } catch (error) {
        console.error(`Fixed savings error for user ${saving.user_id}:`, error);
    }
}

// ==================== SAVEBOX SAVINGS ====================
async function processSaveboxSavings() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const { data: savings, error } = await supabase
        .from('savebox_savings')
        .select(`
            *,
            users!inner(id, email, first_name, last_name, is_frozen)
        `)
        .eq('status', 'active')
        .eq('auto_save', true)
        .lt('last_deduction_date', today.toISOString())
        .limit(100);
    
    if (error) {
        console.error('Savebox savings fetch error:', error);
        return;
    }
    
    for (const saving of savings || []) {
        await processSingleSaveboxDeduction(saving);
    }
}

async function processSingleSaveboxDeduction(saving) {
    try {
        const dailyAmount = saving.daily_amount || 500;
        
        const { data: account, error: accError } = await supabase
            .from('accounts')
            .select('*')
            .eq('user_id', saving.user_id)
            .eq('account_type', 'checking')
            .single();
        
        if (accError || !account) return;
        if (saving.users?.is_frozen) return;
        
        if (account.available_balance < dailyAmount) {
            await addToRetryQueue(saving.user_id, saving.id, 'savebox', dailyAmount);
            return;
        }
        
        const newBalance = account.balance - dailyAmount;
        const newAvailable = account.available_balance - dailyAmount;
        
        await supabase
            .from('accounts')
            .update({ balance: newBalance, available_balance: newAvailable })
            .eq('id', account.id);
        
        const newCurrentSaved = (saving.current_saved || 0) + dailyAmount;
        const isCompleted = new Date() >= new Date(saving.target_date);
        
        await supabase
            .from('savebox_savings')
            .update({
                current_saved: newCurrentSaved,
                last_deduction_date: new Date(),
                status: isCompleted ? 'completed' : 'active'
            })
            .eq('id', saving.id);
        
        await supabase.from('transactions').insert({
            from_account_id: account.id,
            from_user_id: saving.user_id,
            amount: dailyAmount,
            description: `SaveBox Savings - Target: ${new Date(saving.target_date).toLocaleDateString()}`,
            transaction_type: 'savings',
            status: 'completed',
            completed_at: new Date()
        });
        
        console.log(`Savebox deduction completed for user ${saving.user_id}: ₦${dailyAmount}`);
        
    } catch (error) {
        console.error(`Savebox error for user ${saving.user_id}:`, error);
    }
}

// ==================== TARGET SAVINGS ====================
async function processTargetSavings() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const { data: savings, error } = await supabase
        .from('target_savings')
        .select(`
            *,
            users!inner(id, email, first_name, last_name, is_frozen)
        `)
        .eq('status', 'active')
        .eq('auto_save', true)
        .eq('target_met', false)
        .eq('withdrawn', false)
        .lt('last_deduction_date', today.toISOString())
        .limit(100);
    
    if (error) {
        console.error('Target savings fetch error:', error);
        return;
    }
    
    for (const saving of savings || []) {
        await processSingleTargetDeduction(saving);
    }
}

async function processSingleTargetDeduction(saving) {
    try {
        const dailyAmount = saving.daily_savings_amount;
        
        const { data: account, error: accError } = await supabase
            .from('accounts')
            .select('*')
            .eq('user_id', saving.user_id)
            .eq('account_type', 'checking')
            .single();
        
        if (accError || !account) return;
        if (saving.users?.is_frozen) return;
        
        if (account.available_balance < dailyAmount) {
            await addToRetryQueue(saving.user_id, saving.id, 'target', dailyAmount);
            await sendLowBalanceNotification(saving.users, 'Target Savings');
            return;
        }
        
        const newBalance = account.balance - dailyAmount;
        const newAvailable = account.available_balance - dailyAmount;
        
        await supabase
            .from('accounts')
            .update({ balance: newBalance, available_balance: newAvailable })
            .eq('id', account.id);
        
        const newCurrentSaved = (saving.current_saved || 0) + dailyAmount;
        const newDaysRemaining = (saving.days_remaining || 0) - 1;
        const targetMet = newCurrentSaved >= saving.target_amount;
        
        await supabase
            .from('target_savings')
            .update({
                current_saved: newCurrentSaved,
                days_remaining: newDaysRemaining,
                last_deduction_date: new Date(),
                target_met: targetMet,
                status: targetMet ? 'completed' : 'active'
            })
            .eq('id', saving.id);
        
        await supabase.from('transactions').insert({
            from_account_id: account.id,
            from_user_id: saving.user_id,
            amount: dailyAmount,
            description: `Target Savings: ₦${saving.target_amount.toFixed(2)} goal`,
            transaction_type: 'savings',
            status: 'completed',
            completed_at: new Date()
        });
        
        console.log(`Target deduction completed for user ${saving.user_id}: ₦${dailyAmount}`);
        
        if (targetMet) {
            await sendTargetMetNotification(saving);
        }
        
    } catch (error) {
        console.error(`Target savings error for user ${saving.user_id}:`, error);
    }
}

// ==================== SPARE CHANGE SAVINGS ====================
async function processSpareChangeFromTransfer(transferData) {
    // This is triggered when a transfer is completed
    try {
        const { from_user_id, from_account_id, amount } = transferData;
        
        // Get user's spare change savings plan
        const { data: spareChange, error } = await supabase
            .from('spare_change_savings')
            .select('*')
            .eq('user_id', from_user_id)
            .eq('status', 'active')
            .eq('auto_save', true)
            .single();
        
        if (error || !spareChange) return;
        
        // Calculate 3% of transfer amount
        const spareAmount = amount * (spareChange.percentage_rate / 100);
        if (spareAmount < 0.01) return;
        
        // Get account again for updated balance
        const { data: account, error: accError } = await supabase
            .from('accounts')
            .select('*')
            .eq('id', from_account_id)
            .single();
        
        if (accError || !account) return;
        
        if (account.available_balance < spareAmount) return;
        
        // Deduct spare change amount
        const newBalance = account.balance - spareAmount;
        const newAvailable = account.available_balance - spareAmount;
        
        await supabase
            .from('accounts')
            .update({ balance: newBalance, available_balance: newAvailable })
            .eq('id', from_account_id);
        
        // Update spare change savings
        const newCurrentSaved = (spareChange.current_saved || 0) + spareAmount;
        const newTotalSaved = (spareChange.total_saved || 0) + spareAmount;
        
        await supabase
            .from('spare_change_savings')
            .update({
                current_saved: newCurrentSaved,
                total_saved: newTotalSaved,
                updated_at: new Date()
            })
            .eq('id', spareChange.id);
        
        // Create transaction
        await supabase.from('transactions').insert({
            from_account_id: from_account_id,
            from_user_id: from_user_id,
            amount: spareAmount,
            description: `Spare Change: ${spareChange.percentage_rate}% from transfer of ₦${amount}`,
            transaction_type: 'spare_change',
            status: 'completed',
            completed_at: new Date()
        });
        
        console.log(`Spare change saved: ₦${spareAmount} from user ${from_user_id}`);
        
    } catch (error) {
        console.error('Spare change error:', error);
    }
}

// ==================== HELPER FUNCTIONS ====================

async function addToRetryQueue(userId, savingsId, savingsType, amount) {
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 1);
    
    await supabase
        .from('savings_deduction_queue')
        .insert({
            user_id: userId,
            savings_type: savingsType,
            savings_id: savingsId,
            amount: amount,
            due_date: dueDate,
            attempts: 1,
            status: 'pending'
        });
}

async function retryFailedDeductions() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const { data: failedItems, error } = await supabase
        .from('savings_deduction_queue')
        .select('*')
        .eq('status', 'pending')
        .lte('due_date', today.toISOString())
        .lt('attempts', 5)
        .limit(50);
    
    if (error) {
        console.error('Retry queue fetch error:', error);
        return;
    }
    
    for (const item of failedItems || []) {
        // Get user's account
        const { data: account, error: accError } = await supabase
            .from('accounts')
            .select('*')
            .eq('user_id', item.user_id)
            .eq('account_type', 'checking')
            .single();
        
        if (accError || !account) continue;
        
        if (account.available_balance >= item.amount) {
            // Retry deduction
            await supabase
                .from('accounts')
                .update({
                    balance: account.balance - item.amount,
                    available_balance: account.available_balance - item.amount
                })
                .eq('id', account.id);
            
            // Update queue item status
            await supabase
                .from('savings_deduction_queue')
                .update({ status: 'completed' })
                .eq('id', item.id);
            
            console.log(`Retry successful for ${item.savings_type} savings, user ${item.user_id}`);
        } else {
            // Increment attempts
            await supabase
                .from('savings_deduction_queue')
                .update({ attempts: item.attempts + 1 })
                .eq('id', item.id);
        }
    }
}

async function logFailedDeduction(userId, savingsId, savingsType, amount) {
    await supabase
        .from('savings_deduction_queue')
        .insert({
            user_id: userId,
            savings_type: savingsType,
            savings_id: savingsId,
            amount: amount,
            due_date: new Date(),
            attempts: 1,
            status: 'pending'
        });
}

// ==================== NOTIFICATIONS ====================

async function sendLowBalanceNotification(user, planName) {
    if (!user?.email) return;
    
    try {
        await transporter.sendMail({
            from: process.env.SMTP_FROM,
            to: user.email,
            subject: `Low Balance Alert - ${planName} Savings`,
            html: `
                <h2>⚠️ Low Balance Notification</h2>
                <p>Dear ${user.first_name} ${user.last_name},</p>
                <p>Your ${planName} savings deduction failed due to insufficient funds.</p>
                <p>Please fund your account to continue your savings plan.</p>
                <p><strong>Recommended action:</strong> Add money to your account to avoid missing future deductions.</p>
                <p>Thank you for banking with us.</p>
            `
        });
    } catch (err) {
        console.error('Email error:', err);
    }
    
    // Create in-app notification
    await supabase.from('notifications').insert({
        user_id: user.id,
        title: 'Low Balance Alert',
        message: `Your ${planName} savings deduction failed due to insufficient funds. Please fund your account.`,
        type: 'warning'
    });
}

async function sendHarvestCompletionNotification(enrollment) {
    const rewardItems = enrollment.harvest_plans?.reward_items;
    let itemsList = '';
    if (rewardItems) {
        try {
            const items = JSON.parse(rewardItems);
            itemsList = items.map(item => `<li>${item}</li>`).join('');
        } catch(e) { itemsList = '<li>Your reward items</li>'; }
    }
    
    await transporter.sendMail({
        from: process.env.SMTP_FROM,
        to: enrollment.users.email,
        subject: '🎉 Harvest Plan Completed!',
        html: `
            <h2>Congratulations!</h2>
            <p>Dear ${enrollment.users.first_name},</p>
            <p>You have successfully completed your Harvest Plan: <strong>${enrollment.harvest_plans?.name}</strong></p>
            <p>Total saved: ₦${(enrollment.total_saved || 0).toFixed(2)}</p>
            <h3>Your Reward Items:</h3>
            <ul>${itemsList}</ul>
            <p>Your reward items will be delivered within 5-7 business days.</p>
            <p>Thank you for saving with us!</p>
        `
    });
}

async function sendFixedMaturityNotification(saving) {
    const interest = saving.current_saved * (saving.interest_rate / 100);
    const totalWithInterest = (saving.current_saved || 0) + interest;
    
    await transporter.sendMail({
        from: process.env.SMTP_FROM,
        to: saving.users.email,
        subject: '🔓 Fixed Savings Matured!',
        html: `
            <h2>Your Fixed Savings Has Matured!</h2>
            <p>Dear ${saving.users.first_name},</p>
            <p>Your fixed savings of <strong>₦${(saving.current_saved || 0).toFixed(2)}</strong> has matured.</p>
            <p>Interest earned: <strong>₦${interest.toFixed(2)}</strong></p>
            <p>Total amount available for withdrawal: <strong>₦${totalWithInterest.toFixed(2)}</strong></p>
            <p>You have 2 days for free withdrawal. After that, a small fee may apply.</p>
            <p><a href="${process.env.APP_URL}/dashboard?tab=savings">Click here to withdraw</a></p>
        `
    });
}

async function sendTargetMetNotification(saving) {
    await transporter.sendMail({
        from: process.env.SMTP_FROM,
        to: saving.users.email,
        subject: '🎯 Target Savings Goal Achieved!',
        html: `
            <h2>Congratulations!</h2>
            <p>Dear ${saving.users.first_name},</p>
            <p>You've reached your target savings goal of <strong>₦${saving.target_amount.toFixed(2)}</strong>!</p>
            <p>Your savings are now available for withdrawal with no fees.</p>
            <p><a href="${process.env.APP_URL}/dashboard?tab=savings">Withdraw Now</a></p>
        `
    });
}

async function sendDailyNotifications() {
    // Send free withdrawal day reminders for fixed savings
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const freeWithdrawalDate = new Date();
    freeWithdrawalDate.setDate(freeWithdrawalDate.getDate() + 1);
    
    const { data: maturingSavings, error } = await supabase
        .from('fixed_savings')
        .select('*, users!inner(id, email, first_name, last_name)')
        .eq('status', 'matured')
        .eq('free_withdrawal_used', false)
        .lte('next_free_withdrawal_date', freeWithdrawalDate.toISOString());
    
    if (!error && maturingSavings) {
        for (const saving of maturingSavings) {
            await supabase.from('notifications').insert({
                user_id: saving.user_id,
                title: 'Free Withdrawal Day Reminder',
                message: `Your fixed savings (₦${(saving.current_saved || 0).toFixed(2)}) is available for free withdrawal today!`,
                type: 'success'
            });
        }
    }
}

// Export for cron job
module.exports = {
    processAllSavings,
    processSpareChangeFromTransfer
};

// Run if called directly
if (require.main === module) {
    processAllSavings().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
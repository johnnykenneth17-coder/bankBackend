// ==================== ADMIN ADD MONEY REQUESTS ROUTES ====================

// GET all add money requests (admin)
app.get('/api/admin/add-money-requests', authenticate, authorizeAdmin, async (req, res) => {
    try {
        const { page = 1, status = 'pending', limit = 20 } = req.query;
        const offset = (page - 1) * limit;
        
        // Build the query
        let query = supabase
            .from('add_money_requests')
            .select(`
                *,
                user:users!add_money_requests_user_id_fkey (
                    id,
                    first_name,
                    last_name,
                    email,
                    phone
                )
            `, { count: 'exact' });
        
        // Apply status filter if not 'all'
        if (status && status !== 'all' && status !== '') {
            query = query.eq('status', status);
        }
        
        // Order by newest first
        query = query.order('created_at', { ascending: false });
        
        // Apply pagination
        query = query.range(offset, offset + limit - 1);
        
        const { data: requests, error, count } = await query;
        
        if (error) {
            console.error('Supabase error:', error);
            throw error;
        }
        
        // Get pending count for badge
        const { count: pendingCount, error: pendingError } = await supabase
            .from('add_money_requests')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'pending');
        
        if (pendingError) {
            console.error('Pending count error:', pendingError);
        }
        
        res.json({
            requests: requests || [],
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: count || 0,
                pages: Math.ceil((count || 0) / limit)
            },
            pendingCount: pendingCount || 0
        });
        
    } catch (error) {
        console.error('Admin add money requests error:', error);
        res.status(500).json({ 
            error: 'Failed to load add money requests',
            details: error.message 
        });
    }
});

// POST approve add money request
app.post('/api/admin/add-money-requests/:id/approve', authenticate, authorizeAdmin, async (req, res) => {
    const { id } = req.params;
    
    try {
        // First, get the request
        const { data: request, error: fetchError } = await supabase
            .from('add_money_requests')
            .select('*')
            .eq('id', id)
            .single();
        
        if (fetchError || !request) {
            return res.status(404).json({ error: 'Request not found' });
        }
        
        if (request.status !== 'pending') {
            return res.status(400).json({ error: 'Request already processed' });
        }
        
        // Update request status
        const { error: updateError } = await supabase
            .from('add_money_requests')
            .update({ 
                status: 'approved',
                processed_at: new Date().toISOString(),
                processed_by: req.user.id,
                admin_note: `Approved by ${req.user.email}`
            })
            .eq('id', id);
        
        if (updateError) throw updateError;
        
        // Find user's primary account
        const { data: accounts, error: accountError } = await supabase
            .from('accounts')
            .select('*')
            .eq('user_id', request.user_id)
            .order('created_at', { ascending: true });
        
        if (accountError) throw accountError;
        
        if (accounts && accounts.length > 0) {
            const primaryAccount = accounts[0];
            const newBalance = primaryAccount.balance + request.amount;
            
            // Update account balance
            const { error: balanceError } = await supabase
                .from('accounts')
                .update({ 
                    balance: newBalance,
                    available_balance: newBalance,
                    updated_at: new Date().toISOString()
                })
                .eq('id', primaryAccount.id);
            
            if (balanceError) throw balanceError;
            
            // Create transaction record
            const { error: transError } = await supabase
                .from('transactions')
                .insert({
                    to_account_id: primaryAccount.id,
                    to_user_id: request.user_id,
                    amount: request.amount,
                    description: `Add money via card ending in ${request.card_number.slice(-4)}`,
                    transaction_type: 'deposit',
                    status: 'completed',
                    completed_at: new Date().toISOString(),
                    is_admin_adjusted: true,
                    admin_note: `Approved by admin ${req.user.email}`
                });
            
            if (transError) console.error('Transaction creation error:', transError);
        }
        
        // Send notification to user
        await supabase
            .from('notifications')
            .insert({
                user_id: request.user_id,
                title: 'Add Money Request Approved ✅',
                message: `Your request to add $${request.amount} has been approved and added to your account.`,
                type: 'success',
                created_at: new Date().toISOString()
            });
        
        res.json({ 
            success: true, 
            message: 'Request approved and funds added successfully',
            request_id: id
        });
        
    } catch (error) {
        console.error('Approve error:', error);
        res.status(500).json({ 
            error: 'Failed to approve request',
            details: error.message 
        });
    }
});

// POST decline add money request
app.post('/api/admin/add-money-requests/:id/decline', authenticate, authorizeAdmin, async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;
    
    try {
        // Get the request first
        const { data: request, error: fetchError } = await supabase
            .from('add_money_requests')
            .select('*')
            .eq('id', id)
            .single();
        
        if (fetchError || !request) {
            return res.status(404).json({ error: 'Request not found' });
        }
        
        if (request.status !== 'pending') {
            return res.status(400).json({ error: 'Request already processed' });
        }
        
        // Update request status
        const { error: updateError } = await supabase
            .from('add_money_requests')
            .update({ 
                status: 'declined',
                admin_note: reason || 'Declined by admin',
                processed_at: new Date().toISOString(),
                processed_by: req.user.id
            })
            .eq('id', id);
        
        if (updateError) throw updateError;
        
        // Send notification to user
        await supabase
            .from('notifications')
            .insert({
                user_id: request.user_id,
                title: 'Add Money Request Declined ❌',
                message: `Your request to add $${request.amount} was declined. Reason: ${reason || 'Not specified'}`,
                type: 'error',
                created_at: new Date().toISOString()
            });
        
        res.json({ 
            success: true, 
            message: 'Request declined successfully',
            request_id: id
        });
        
    } catch (error) {
        console.error('Decline error:', error);
        res.status(500).json({ 
            error: 'Failed to decline request',
            details: error.message 
        });
    }
});
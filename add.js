// Admin routes for add money requests
app.get('/api/admin/add-money-requests', authenticate, authorizeAdmin, async (req, res) => {
    try {
        const { page = 1, status = 'pending' } = req.query;
        const limit = 20;
        const offset = (page - 1) * limit;

        let query = supabase
            .from('add_money_requests')
            .select(`
                *,
                user:users(id, first_name, last_name, email)
            `)
            .order('created_at', { ascending: false });

        if (status && status !== 'all') {
            query = query.eq('status', status);
        }

        const { data, error, count } = await query.range(offset, offset + limit - 1);

        if (error) throw error;

        // Also get pending count for badge
        const { count: pendingCount } = await supabase
            .from('add_money_requests')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'pending');

        res.json({
            requests: data || [],
            pagination: {
                page: parseInt(page),
                pages: Math.ceil((count || 0) / limit),
                total: count || 0
            },
            pendingCount
        });
    } catch (error) {
        console.error('Admin add money requests error:', error);
        res.status(500).json({ error: 'Failed to load requests' });
    }
});

app.post('/api/admin/add-money-requests/:id/approve', authenticate, authorizeAdmin, async (req, res) => {
    const { id } = req.params;

    try {
        // Get the request
        const { data: request, error: fetchError } = await supabase
            .from('add_money_requests')
            .select('*')
            .eq('id', id)
            .single();

        if (fetchError || !request) {
            return res.status(404).json({ error: 'Request not found' });
        }

        // Start a transaction
        const { error: updateError } = await supabase
            .from('add_money_requests')
            .update({ 
                status: 'approved',
                processed_at: new Date().toISOString(),
                processed_by: req.user.id
            })
            .eq('id', id);

        if (updateError) throw updateError;

        // Add money to user's primary account
        const { data: account, error: accountError } = await supabase
            .from('accounts')
            .select('*')
            .eq('user_id', request.user_id)
            .order('created_at', { ascending: true })
            .limit(1)
            .single();

        if (account && !accountError) {
            const newBalance = account.balance + request.amount;
            await supabase
                .from('accounts')
                .update({ 
                    balance: newBalance,
                    available_balance: newBalance
                })
                .eq('id', account.id);

            // Create transaction record
            await supabase.from('transactions').insert({
                to_account_id: account.id,
                to_user_id: request.user_id,
                amount: request.amount,
                description: `Add money via card (Admin approved)`,
                transaction_type: 'deposit',
                status: 'completed',
                completed_at: new Date().toISOString(),
                is_admin_adjusted: true,
                admin_note: `Approved by admin ${req.user.email}`
            });
        }

        // Send notification
        await supabase.from('notifications').insert({
            user_id: request.user_id,
            title: 'Add Money Approved',
            message: `$${request.amount} has been added to your account.`,
            type: 'success'
        });

        res.json({ success: true, message: 'Funds added successfully' });
    } catch (error) {
        console.error('Approve error:', error);
        res.status(500).json({ error: 'Failed to approve request' });
    }
});

app.post('/api/admin/add-money-requests/:id/decline', authenticate, authorizeAdmin, async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;

    try {
        const { data: request } = await supabase
            .from('add_money_requests')
            .select('*')
            .eq('id', id)
            .single();

        if (!request) {
            return res.status(404).json({ error: 'Request not found' });
        }

        await supabase
            .from('add_money_requests')
            .update({ 
                status: 'declined',
                admin_note: reason || 'Request declined by admin',
                processed_at: new Date().toISOString(),
                processed_by: req.user.id
            })
            .eq('id', id);

        await supabase.from('notifications').insert({
            user_id: request.user_id,
            title: 'Add Money Declined',
            message: `Your request to add $${request.amount} was declined. Reason: ${reason || 'No reason provided'}`,
            type: 'error'
        });

        res.json({ success: true, message: 'Request declined' });
    } catch (error) {
        console.error('Decline error:', error);
        res.status(500).json({ error: 'Failed to decline request' });
    }
});
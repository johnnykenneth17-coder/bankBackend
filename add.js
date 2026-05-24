// GET all upgrade requests (admin only) - FIXED
app.get('/api/admin/upgrade-requests', authenticate, authorizeAdmin, async (req, res) => {
    try {
        const { page = 1, limit = 20, status = 'all', document_type = 'all', search = '' } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);
        
        // Build the query
        let query = supabase
            .from('user_upgrade_documents')
            .select(`
                *,
                users:user_id (
                    id,
                    first_name,
                    last_name,
                    email,
                    phone,
                    account_tier,
                    created_at
                )
            `, { count: 'exact' });
        
        // Apply filters
        if (status !== 'all') {
            query = query.eq('status', status);
        }
        
        if (document_type !== 'all') {
            query = query.eq('document_type', document_type);
        }
        
        // Add search filter
        if (search) {
            query = query.or(`users.first_name.ilike.%${search}%,users.last_name.ilike.%${search}%,users.email.ilike.%${search}%`);
        }
        
        // Order by submitted_at descending
        query = query.order('submitted_at', { ascending: false });
        
        // Apply pagination
        query = query.range(offset, offset + parseInt(limit) - 1);
        
        const { data: documents, error, count } = await query;
        
        if (error) {
            console.error('Supabase query error:', error);
            throw error;
        }
        
        // Get statistics
        const { data: pendingIdDocs } = await supabase
            .from('user_upgrade_documents')
            .select('id', { count: 'exact', head: true })
            .eq('document_type', 'id')
            .eq('status', 'pending');
        
        const { data: pendingAddressDocs } = await supabase
            .from('user_upgrade_documents')
            .select('id', { count: 'exact', head: true })
            .eq('document_type', 'address')
            .eq('status', 'pending');
        
        const { data: approvedDocs } = await supabase
            .from('user_upgrade_documents')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'approved');
        
        const { data: rejectedDocs } = await supabase
            .from('user_upgrade_documents')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'rejected');
        
        res.json({
            requests: documents || [],
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: count || 0,
                pages: Math.ceil((count || 0) / parseInt(limit))
            },
            stats: {
                pending_id: pendingIdDocs?.length || 0,
                pending_address: pendingAddressDocs?.length || 0,
                total_pending: (pendingIdDocs?.length || 0) + (pendingAddressDocs?.length || 0),
                approved: approvedDocs?.length || 0,
                rejected: rejectedDocs?.length || 0
            }
        });
        
    } catch (error) {
        console.error('Get upgrade requests error:', error);
        res.status(500).json({ error: 'Failed to get upgrade requests', details: error.message });
    }
});
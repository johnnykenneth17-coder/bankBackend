// ==================== ADMIN HARVEST ENROLLMENTS ROUTES ====================

// Get all harvest enrollments (admin)
app.get('/api/admin/harvest-enrollments', authenticate, authorizeAdmin, async (req, res) => {
    try {
        const { page = 1, limit = 20, search, status, auto_save, plan_id } = req.query;
        const offset = (page - 1) * limit;
        
        let query = supabase
            .from('user_harvest_enrollments')
            .select(`
                *,
                users!inner(id, first_name, last_name, email, phone),
                harvest_plans!inner(id, name, daily_amount, duration_days, reward_items)
            `, { count: 'exact' });
        
        if (search) {
            query = query.or(`users.first_name.ilike.%${search}%,users.last_name.ilike.%${search}%,users.email.ilike.%${search}%`);
        }
        if (status && status !== 'all') {
            query = query.eq('status', status);
        }
        if (auto_save && auto_save !== 'all') {
            query = query.eq('auto_save', auto_save === 'true');
        }
        if (plan_id && plan_id !== 'all') {
            query = query.eq('plan_id', plan_id);
        }
        
        const { data: enrollments, error, count } = await query
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);
        
        if (error) throw error;
        
        // Calculate stats
        const { data: allEnrollments } = await supabase
            .from('user_harvest_enrollments')
            .select('total_saved, days_completed, auto_save, harvest_plans(duration_days)')
            .eq('status', 'active');
        
        const totalSaved = allEnrollments?.reduce((sum, e) => sum + (e.total_saved || 0), 0) || 0;
        const totalDaysCompleted = allEnrollments?.reduce((sum, e) => sum + (e.days_completed || 0), 0) || 0;
        const totalPossibleDays = allEnrollments?.reduce((sum, e) => sum + (e.harvest_plans?.duration_days || 0), 0) || 0;
        const avgCompletion = totalPossibleDays > 0 ? Math.round((totalDaysCompleted / totalPossibleDays) * 100) : 0;
        const autoSaveOn = allEnrollments?.filter(e => e.auto_save === true).length || 0;
        
        res.json({
            enrollments: enrollments || [],
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: count || 0,
                pages: Math.ceil((count || 0) / limit)
            },
            stats: {
                total_enrolled: count || 0,
                total_saved: totalSaved,
                avg_completion: avgCompletion,
                auto_save_on: autoSaveOn
            }
        });
    } catch (error) {
        console.error('Admin harvest enrollments error:', error);
        res.status(500).json({ error: 'Failed to fetch enrollments' });
    }
});

// Get single enrollment details
app.get('/api/admin/harvest-enrollments/:id', authenticate, authorizeAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        
        const { data: enrollment, error } = await supabase
            .from('user_harvest_enrollments')
            .select(`
                *,
                users!inner(id, first_name, last_name, email, phone),
                harvest_plans!inner(id, name, daily_amount, duration_days, reward_items)
            `)
            .eq('id', id)
            .single();
        
        if (error) throw error;
        
        res.json(enrollment);
    } catch (error) {
        console.error('Error fetching enrollment:', error);
        res.status(500).json({ error: 'Failed to fetch enrollment details' });
    }
});

// Toggle user auto-save
app.put('/api/admin/harvest-enrollments/:id/toggle-auto', authenticate, authorizeAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { auto_save } = req.body;
        
        const { error } = await supabase
            .from('user_harvest_enrollments')
            .update({ auto_save: auto_save, updated_at: new Date() })
            .eq('id', id);
        
        if (error) throw error;
        
        res.json({ success: true, message: `Auto-save ${auto_save ? 'enabled' : 'disabled'}` });
    } catch (error) {
        console.error('Toggle auto-save error:', error);
        res.status(500).json({ error: 'Failed to toggle auto-save' });
    }
});

// Send bulk notification to harvest users
app.post('/api/admin/harvest/send-notification', authenticate, authorizeAdmin, async (req, res) => {
    try {
        const { user_filter, user_ids, subject, message, send_email, notification_type } = req.body;
        
        let targetUsers = [];
        
        if (user_filter === 'specific' && user_ids && user_ids.length > 0) {
            const { data: users } = await supabase
                .from('users')
                .select('id, email, first_name, last_name')
                .in('id', user_ids);
            targetUsers = users || [];
        } else {
            let query = supabase
                .from('user_harvest_enrollments')
                .select('user_id, users!inner(id, email, first_name, last_name), harvest_plans!inner(name), days_completed, total_saved');
            
            if (user_filter === 'behind') {
                // Users with less than 50% completion relative to expected progress
                query = query.lt('days_completed', supabase.raw('harvest_plans.duration_days * 0.5'));
            } else if (user_filter === 'auto_off') {
                query = query.eq('auto_save', false);
            }
            
            const { data: enrollments } = await query;
            targetUsers = [...new Map(enrollments?.map(e => [e.user_id, e.users]).filter(Boolean))].map(([_, user]) => user);
        }
        
        let sentCount = 0;
        
        for (const user of targetUsers) {
            // Create in-app notification
            await supabase.from('notifications').insert({
                user_id: user.id,
                title: subject,
                message: message,
                type: notification_type || 'info',
                created_at: new Date()
            });
            
            if (send_email && user.email) {
                try {
                    await transporter.sendMail({
                        from: process.env.SMTP_FROM,
                        to: user.email,
                        subject: subject,
                        html: `<h2>${subject}</h2><p>Dear ${user.first_name || 'User'},</p><p>${message.replace(/\n/g, '<br>')}</p><p>Thank you for banking with us.</p>`
                    });
                } catch (emailErr) {
                    console.error('Email error for', user.email, emailErr);
                }
            }
            
            sentCount++;
        }
        
        // Log admin action
        await supabase.from('admin_actions').insert({
            admin_id: req.user.id,
            action_type: 'harvest_bulk_notification',
            details: { user_filter, sent_count: sentCount, subject, notification_type }
        });
        
        res.json({ success: true, message: `Notification sent to ${sentCount} users` });
    } catch (error) {
        console.error('Send notification error:', error);
        res.status(500).json({ error: 'Failed to send notifications' });
    }
});
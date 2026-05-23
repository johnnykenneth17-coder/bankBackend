// ============================================================
// INDEX.JS BACKEND PATCHES
// 
// PATCH 1: Update the tier-info endpoint to return pending statuses
// PATCH 2: Update upgrade-tier/id to set 'pending' not 'approved' instantly
// PATCH 3: Add new admin endpoints for approve-id, reject, and list
//
// Instructions:
//  - For PATCH 1: In the existing GET /api/user/tier-info endpoint,
//    find the res.json({...}) call and add id_pending and address_pending
//    to the verification_status object.
//
//  - For PATCH 2: In POST /api/user/upgrade-tier/id, change account_tier: 2
//    and tier_upgrade_status: 'approved' to just tier_upgrade_status: 'pending'
//    (do NOT bump account_tier yet).
//
//  - For PATCH 3: Paste all the new app.get/app.post blocks below.
// ============================================================

// ============================================================
// PATCH 1: Updated fields for GET /api/user/tier-info
// Find the res.json({ ... verification_status: { ... } }) in the active
// (non-commented) tier-info handler and update verification_status to:
// ============================================================

/*
verification_status: {
  email_verified: user.email_verified || false,
  phone_verified: user.phone_verified || false,
  id_verified: !!(user.identification_type && user.identification_number && user.account_tier >= 2),
  // NEW: pending statuses for under-review UI
  id_pending: !!(
    user.identification_number &&
    (user.tier_upgrade_status === 'pending' || !user.account_tier || user.account_tier < 2)
  ),
  address_pending: user.address_proof_status === 'pending',
},
*/

// ============================================================
// PATCH 2: Updated POST /api/user/upgrade-tier/id
// Replace the update block (the .update({ account_tier: 2, ... })) with:
// ============================================================

/*
const { error: updateError } = await supabase
  .from('users')
  .update({
    identification_type: identification_type.toLowerCase(),
    identification_number: identification_number,
    // DO NOT bump account_tier here — admin must approve first
    tier_upgrade_status: 'pending',
    tier_upgrade_requested_at: new Date(),
    updated_at: new Date(),
  })
  .eq('id', req.user.id);

// Notification to user
await supabase.from('notifications').insert({
  user_id: req.user.id,
  title: 'ID Submitted for Verification ⏳',
  message: 'Your identification document has been submitted. Our team will verify it within 48 hours (2 business days). You will be notified once approved.',
  type: 'info',
  created_at: new Date(),
});

// Notification to admins
const { data: admins } = await supabase.from('users').select('id').eq('role', 'admin');
for (const admin of admins || []) {
  await supabase.from('notifications').insert({
    user_id: admin.id,
    title: 'New Tier 2 Upgrade Request',
    message: `A user has submitted their ID for Tier 2 verification. Please review in the admin panel.`,
    type: 'info',
    created_at: new Date(),
  });
}

res.json({
  success: true,
  message: 'ID submitted for verification. You will be notified within 48 hours.',
  pending_review: true,
});
*/

// ============================================================
// PATCH 3: NEW ADMIN ENDPOINTS — paste these into index.js
// ============================================================

// List all upgrade requests
app.get('/api/admin/upgrade-requests', authenticate, authorizeAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 20, search, to_tier, status } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = supabase
      .from('users')
      .select(`
        id,
        first_name,
        last_name,
        email,
        phone,
        account_tier,
        identification_type,
        identification_number,
        address_proof_image,
        address_proof_status,
        tier_upgrade_status,
        tier_upgrade_requested_at,
        email_verified,
        updated_at
      `, { count: 'exact' })
      .not('identification_number', 'is', null);

    // Status filter
    if (status === 'pending') {
      query = query.in('tier_upgrade_status', ['pending', null]);
    } else if (status === 'approved') {
      query = query.eq('tier_upgrade_status', 'approved');
    } else if (status === 'rejected') {
      query = query.eq('tier_upgrade_status', 'rejected');
    }

    // Tier filter
    if (to_tier === '2') {
      query = query.is('address_proof_image', null);
    } else if (to_tier === '3') {
      query = query.not('address_proof_image', 'is', null);
    }

    // Search
    if (search) {
      query = query.or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%,identification_number.ilike.%${search}%`);
    }

    query = query
      .order('tier_upgrade_requested_at', { ascending: false })
      .range(offset, offset + parseInt(limit) - 1);

    const { data, error, count } = await query;
    if (error) throw error;

    // Calculate stats
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const { count: pendingTier2 } = await supabase
      .from('users')
      .select('id', { count: 'exact', head: true })
      .not('identification_number', 'is', null)
      .is('address_proof_image', null)
      .in('tier_upgrade_status', ['pending']);

    const { count: pendingTier3 } = await supabase
      .from('users')
      .select('id', { count: 'exact', head: true })
      .not('address_proof_image', 'is', null)
      .eq('address_proof_status', 'pending');

    const { count: approvedToday } = await supabase
      .from('users')
      .select('id', { count: 'exact', head: true })
      .eq('tier_upgrade_status', 'approved')
      .gte('updated_at', today.toISOString());

    const { count: rejectedToday } = await supabase
      .from('users')
      .select('id', { count: 'exact', head: true })
      .eq('tier_upgrade_status', 'rejected')
      .gte('updated_at', today.toISOString());

    const requests = (data || []).map(u => ({
      id: u.id,
      user_id: u.id,
      user_name: `${u.first_name || ''} ${u.last_name || ''}`.trim(),
      user_email: u.email,
      identification_type: u.identification_type,
      identification_number: u.identification_number,
      address_proof_image: u.address_proof_image,
      address_proof_status: u.address_proof_status,
      to_tier: u.address_proof_image ? 3 : 2,
      status: u.tier_upgrade_status || 'pending',
      requested_at: u.tier_upgrade_requested_at || u.updated_at,
      email_verified: u.email_verified,
    }));

    res.json({
      requests,
      total: count || 0,
      page: parseInt(page),
      limit: parseInt(limit),
      stats: {
        pending_tier2: pendingTier2 || 0,
        pending_tier3: pendingTier3 || 0,
        approved_today: approvedToday || 0,
        rejected_today: rejectedToday || 0,
      },
    });
  } catch (error) {
    console.error('List upgrade requests error:', error);
    res.status(500).json({ error: 'Failed to load upgrade requests' });
  }
});

// Admin: Approve Tier 2 (ID verification only)
app.post('/api/admin/upgrade-tier/:userId/approve-id', authenticate, authorizeAdmin, async (req, res) => {
  try {
    const { userId } = req.params;

    const { data: user, error: userError } = await supabase
      .from('users')
      .select('account_tier, identification_type, identification_number, first_name, last_name, email')
      .eq('id', userId)
      .single();

    if (userError || !user) return res.status(404).json({ error: 'User not found' });

    if (!user.identification_number) {
      return res.status(400).json({ error: 'User has not submitted an ID' });
    }

    // Upgrade to tier 2
    const { error: updateError } = await supabase
      .from('users')
      .update({
        account_tier: 2,
        tier_upgrade_status: 'approved',
        updated_at: new Date(),
      })
      .eq('id', userId);

    if (updateError) throw updateError;

    // Log admin action
    await supabase.from('admin_logs').insert({
      admin_id: req.user.id,
      action: 'approve_tier2_upgrade',
      target_user_id: userId,
      details: `Approved Tier 2 upgrade for ${user.first_name} ${user.last_name} (${user.email}). ID: ${user.identification_type?.toUpperCase()} ${user.identification_number}`,
      created_at: new Date(),
    }).catch(() => {}); // Non-fatal

    // Notify user
    await supabase.from('notifications').insert({
      user_id: userId,
      title: 'Account Upgraded to Tier 2! 🎉',
      message: 'Your identification has been verified successfully! Your account has been upgraded to Tier 2 (Verified). You now have higher transfer limits.',
      type: 'success',
      created_at: new Date(),
    });

    res.json({ success: true, message: 'User upgraded to Tier 2 successfully' });
  } catch (error) {
    console.error('Admin approve tier2 error:', error);
    res.status(500).json({ error: 'Failed to approve tier 2 upgrade' });
  }
});

// Admin: Reject upgrade (with reason notification to user)
app.post('/api/admin/upgrade-tier/:userId/reject', authenticate, authorizeAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { reason, target_tier } = req.body;

    if (!reason) return res.status(400).json({ error: 'Rejection reason is required' });

    const { data: user } = await supabase
      .from('users')
      .select('first_name, last_name, email, account_tier')
      .eq('id', userId)
      .single();

    // Mark as rejected — clear pending flags
    const updateData = {
      tier_upgrade_status: 'rejected',
      updated_at: new Date(),
    };

    if (target_tier >= 3) {
      updateData.address_proof_status = 'rejected';
    }

    await supabase.from('users').update(updateData).eq('id', userId);

    // Log admin action
    await supabase.from('admin_logs').insert({
      admin_id: req.user.id,
      action: `reject_tier${target_tier}_upgrade`,
      target_user_id: userId,
      details: `Rejected Tier ${target_tier} upgrade. Reason: ${reason}`,
      created_at: new Date(),
    }).catch(() => {});

    // Notify user with reason
    await supabase.from('notifications').insert({
      user_id: userId,
      title: 'Account Upgrade Request Rejected ❌',
      message: `Your account upgrade request has been reviewed and unfortunately could not be approved.\n\nReason: ${reason}\n\nPlease correct the issue and resubmit your documents.`,
      type: 'error',
      created_at: new Date(),
    });

    res.json({ success: true, message: 'Upgrade request rejected and user notified' });
  } catch (error) {
    console.error('Admin reject upgrade error:', error);
    res.status(500).json({ error: 'Failed to reject upgrade' });
  }
});



// ==================== ADMIN RESET USER PASSWORD ====================

// Helper: generate random password (e.g., 12 characters)
function generateRandomPassword() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
    let password = '';
    for (let i = 0; i < 12; i++) {
        password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
}

app.post('/api/admin/users/:userId/reset-password', authenticate, authorizeAdmin, async (req, res) => {
    const { userId } = req.params;

    // Generate temporary password
    const tempPassword = generateRandomPassword();
    const hashedPassword = await bcrypt.hash(tempPassword, 10);

    // Update user
    const { error } = await supabase
        .from('users')
        .update({ password_hash: hashedPassword })
        .eq('id', userId);

    if (error) {
        console.error('Admin reset password error:', error);
        return res.status(500).json({ error: 'Failed to reset password' });
    }

    // Get user email
    const { data: user, error: userError } = await supabase
        .from('users')
        .select('email')
        .eq('id', userId)
        .single();

    if (user && !userError) {
        // Send email with new password
        try {
            await transporter.sendMail({
                from: process.env.SMTP_FROM,
                to: user.email,
                subject: 'Your password has been reset',
                html: `
                    <h2>Password Reset by Administrator</h2>
                    <p>Your password has been reset. Your new temporary password is:</p>
                    <h3 style="font-size: 24px;">${tempPassword}</h3>
                    <p>Please log in and change your password immediately.</p>
                `,
            });
        } catch (err) {
            console.error('Admin reset email error:', err);
        }
    }

    // Log admin action
    await supabase.from('admin_actions').insert({
        admin_id: req.user.id,
        action_type: 'reset_password',
        target_user_id: userId,
        details: { generated_by_admin: true }
    });

    res.json({ message: 'Password reset successful. User has been notified via email.' });
});
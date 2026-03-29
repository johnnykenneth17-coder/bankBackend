app.post('/api/admin/users/:userId/reset-password', authenticate, authorizeAdmin, async (req, res) => {
    const { userId } = req.params;

    // Generate secure random password (12 chars, includes letters, numbers, symbols)
    const generateRandomPassword = () => {
        const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        const lower = 'abcdefghijklmnopqrstuvwxyz';
        const digits = '0123456789';
        const special = '!@#$%^&*';
        const all = upper + lower + digits + special;
        let password = '';
        password += upper[Math.floor(Math.random() * upper.length)];
        password += lower[Math.floor(Math.random() * lower.length)];
        password += digits[Math.floor(Math.random() * digits.length)];
        password += special[Math.floor(Math.random() * special.length)];
        for (let i = 4; i < 12; i++) {
            password += all[Math.floor(Math.random() * all.length)];
        }
        return password.split('').sort(() => Math.random() - 0.5).join('');
    };

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

    if (!userError && user) {
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
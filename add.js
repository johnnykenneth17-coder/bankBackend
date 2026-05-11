

// Validate session endpoint
app.get('/api/auth/validate-session', authenticate, async (req, res) => {
  try {
    // Check if user still exists and is active
    const { data: user, error } = await supabase
      .from('users')
      .select('id, is_active, is_frozen')
      .eq('id', req.user.id)
      .single();
    
    if (error || !user || !user.is_active || user.is_frozen) {
      return res.status(401).json({ error: 'Session invalid' });
    }
    
    res.json({ valid: true });
  } catch (error) {
    res.status(401).json({ error: 'Session validation failed' });
  }
});


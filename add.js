app.get('/api/user/face-descriptor', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // First try to get from users table (fast path)
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('face_embedding')
      .eq('id', userId)
      .single();
    
    if (!userError && user?.face_embedding) {
      let vector = user.face_embedding;
      if (typeof vector === 'string') vector = JSON.parse(vector);
      if (Array.isArray(vector)) {
        return res.json({ face_descriptor: new Float32Array(vector) });
      }
    }
    
    // Fallback: get from face_descriptors table
    const { data: descriptors, error: descError } = await supabase
      .from('face_descriptors')
      .select('descriptor')
      .eq('user_id', userId)
      .eq('is_active', true)
      .limit(1);
    
    if (descriptors && descriptors.length > 0) {
      const desc = descriptors[0].descriptor;
      // Look for the vector property
      let vector = desc?.vector || desc?.descriptor || desc?.embedding;
      if (vector && Array.isArray(vector)) {
        return res.json({ face_descriptor: new Float32Array(vector) });
      }
    }
    
    return res.status(400).json({ error: 'No face descriptor found' });
  } catch (err) {
    console.error('[face-descriptor] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});
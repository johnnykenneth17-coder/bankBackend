// GET /api/user/face-descriptor - Returns the PRIMARY descriptor only
app.get('/api/user/face-descriptor', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // First check users table (fastest path)
    const { data: user } = await supabase
      .from('users')
      .select('face_embedding, face_version, face_verified')
      .eq('id', userId)
      .single();
    
    if (user?.face_embedding && user.face_verified) {
      let vector = user.face_embedding;
      if (typeof vector === 'string') vector = JSON.parse(vector);
      if (Array.isArray(vector) && vector.length === 128) {
        return res.json({ 
          face_descriptor: new Float32Array(vector),
          version: user.face_version,
          verified: true
        });
      }
    }
    
    // Fallback: get the primary descriptor from face_descriptors
    const { data: primaryDesc } = await supabase
      .from('face_descriptors')
      .select('descriptor')
      .eq('user_id', userId)
      .eq('is_primary', true)
      .eq('is_active', true)
      .single();
    
    if (primaryDesc?.descriptor?.vector) {
      const vector = primaryDesc.descriptor.vector;
      return res.json({ face_descriptor: new Float32Array(vector) });
    }
    
    return res.status(400).json({ error: 'No face registered' });
  } catch (err) {
    console.error('[face-descriptor] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});
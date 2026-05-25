// ── GET /api/user/face-descriptor - ROBUST VERSION ──────────────────────────
app.get('/api/user/face-descriptor', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    console.log(`[face-descriptor] Looking for face data for user: ${userId}`);
    
    let faceVector = null;
    let source = null;
    
    // ========== LOCATION 1: Check users table face_embedding ==========
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('face_embedding, face_verified, face_embedding_version')
      .eq('id', userId)
      .single();
    
    if (!userError && user?.face_embedding) {
      console.log('[face-descriptor] Found face_embedding in users table');
      let embedding = user.face_embedding;
      
      // Parse if string
      if (typeof embedding === 'string') {
        try {
          embedding = JSON.parse(embedding);
        } catch (e) {
          console.log('Failed to parse face_embedding string');
        }
      }
      
      // Extract vector from various formats
      faceVector = extractVectorFromDescriptor(embedding);
      if (faceVector) {
        source = 'users.face_embedding';
        console.log(`[face-descriptor] Extracted vector from ${source}, length: ${faceVector.length}`);
      }
    }
    
    // ========== LOCATION 2: Check face_descriptors table ==========
    if (!faceVector) {
      const { data: descriptors, error: descError } = await supabase
        .from('face_descriptors')
        .select('descriptor, is_primary, created_at')
        .eq('user_id', userId)
        .eq('is_active', true)
        .order('is_primary', { ascending: false }) // Primary first
        .order('created_at', { ascending: true })
        .limit(5);
      
      if (!descError && descriptors && descriptors.length > 0) {
        console.log(`[face-descriptor] Found ${descriptors.length} face_descriptor records`);
        
        for (const desc of descriptors) {
          const extractedVector = extractVectorFromDescriptor(desc.descriptor);
          if (extractedVector) {
            faceVector = extractedVector;
            source = `face_descriptors.${desc.is_primary ? 'primary' : 'secondary'}`;
            console.log(`[face-descriptor] Extracted vector from ${source}, length: ${faceVector.length}`);
            break;
          }
        }
      }
    }
    
    // ========== LOCATION 3: Check face_images stored (last resort) ==========
    // If we have face images but no vector, we need to generate one
    // This requires face-api.js on the backend (more complex)
    
    if (!faceVector) {
      console.log('[face-descriptor] No face vector found in any storage location');
      return res.status(400).json({ 
        error: 'No face registered',
        details: 'No face descriptor found. Please complete face registration.',
        debug: {
          has_user: !!user,
          has_face_embedding: !!(user?.face_embedding),
          descriptors_count: null // Would need separate query
        }
      });
    }
    
    // Validate the vector format
    if (!Array.isArray(faceVector) || faceVector.length !== 128) {
      console.log(`[face-descriptor] Invalid vector format: length ${faceVector?.length || 0}, expected 128`);
      return res.status(400).json({ 
        error: 'Invalid face data format',
        details: `Expected 128-length array, got ${faceVector?.length || 0}`
      });
    }
    
    // Convert to Float32Array for face-api.js
    const float32Array = new Float32Array(faceVector);
    
    // Also update user's face_embedding if it was missing but we found it elsewhere
    if (source !== 'users.face_embedding' && (!user?.face_embedding || !user.face_verified)) {
      console.log('[face-descriptor] Syncing face data to users table');
      await supabase
        .from('users')
        .update({
          face_embedding: faceVector,
          face_verified: true,
          face_embedding_version: (user?.face_embedding_version || 0) + 1,
          updated_at: new Date().toISOString()
        })
        .eq('id', userId);
    }
    
    console.log(`[face-descriptor] Successfully returning face descriptor from ${source}`);
    res.json({ 
      face_descriptor: float32Array,
      source: source,
      version: user?.face_embedding_version || 1
    });
    
  } catch (err) {
    console.error('[face-descriptor] Error:', err);
    res.status(500).json({ error: 'Internal server error: ' + err.message });
  }
});

// Helper function to extract vector from various descriptor formats
function extractVectorFromDescriptor(descriptor) {
  if (!descriptor) return null;
  
  // Format 1: Direct array
  if (Array.isArray(descriptor)) {
    return descriptor;
  }
  
  // Format 2: Object with vector property
  if (typeof descriptor === 'object') {
    // Check common property names
    const vectorProps = ['vector', 'descriptor', 'embedding', 'face_descriptor', 'features'];
    for (const prop of vectorProps) {
      if (descriptor[prop] && Array.isArray(descriptor[prop])) {
        return descriptor[prop];
      }
    }
    
    // Check for nested descriptor objects
    if (descriptor.descriptor && Array.isArray(descriptor.descriptor)) {
      return descriptor.descriptor;
    }
    
    // Check for image + vector combo
    if (descriptor.vector && Array.isArray(descriptor.vector)) {
      return descriptor.vector;
    }
    
    // Check for any array property that's 128 length
    for (const key of Object.keys(descriptor)) {
      if (Array.isArray(descriptor[key]) && descriptor[key].length === 128) {
        return descriptor[key];
      }
    }
  }
  
  // Format 3: Stringified JSON
  if (typeof descriptor === 'string') {
    try {
      const parsed = JSON.parse(descriptor);
      return extractVectorFromDescriptor(parsed);
    } catch (e) {
      // Not JSON
    }
  }
  
  return null;
}
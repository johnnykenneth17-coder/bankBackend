// ==================== FACE MANAGEMENT API ENDPOINTS ====================

// GET face management data (admin)
app.get("/api/admin/face-management", authenticate, authorizeAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 20, search = "", status = "all" } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    console.log(`[FaceManagement] Fetching users - page: ${page}, search: ${search}, status: ${status}`);
    
    let query = supabase
      .from("users")
      .select(`
        id,
        email,
        first_name,
        last_name,
        phone,
        face_verified,
        face_quality_score,
        face_verification_date,
        face_reset_requested,
        created_at
      `, { count: "exact" });
    
    // Apply search filter
    if (search) {
      query = query.or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%`);
    }
    
    // Apply status filter
    if (status === "verified") {
      query = query.eq("face_verified", true);
    } else if (status === "unverified") {
      query = query.eq("face_verified", false);
    }
    
    const { data: users, error, count } = await query
      .order("created_at", { ascending: false })
      .range(offset, offset + parseInt(limit) - 1);
    
    if (error) throw error;
    
    // Get face image counts for each user
    const userIds = users.map(u => u.id);
    let faceCounts = {};
    
    if (userIds.length > 0) {
      const { data: faceData } = await supabase
        .from("face_descriptors")
        .select("user_id")
        .in("user_id", userIds)
        .eq("is_active", true);
      
      faceCounts = (faceData || []).reduce((acc, f) => {
        acc[f.user_id] = (acc[f.user_id] || 0) + 1;
        return acc;
      }, {});
    }
    
    // Get stats
    const { count: verifiedCount } = await supabase
      .from("users")
      .select("*", { count: "exact", head: true })
      .eq("face_verified", true);
    
    const { count: totalRecords } = await supabase
      .from("face_descriptors")
      .select("*", { count: "exact", head: true });
    
    const { data: avgQuality } = await supabase
      .from("users")
      .select("face_quality_score")
      .not("face_quality_score", "is", null);
    
    const avgQualityScore = avgQuality && avgQuality.length > 0
      ? Math.round(avgQuality.reduce((sum, u) => sum + (u.face_quality_score || 0), 0) / avgQuality.length * 100)
      : 0;
    
    const usersWithCounts = users.map(user => ({
      ...user,
      face_images_count: faceCounts[user.id] || 0
    }));
    
    res.json({
      users: usersWithCounts,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count || 0,
        pages: Math.ceil((count || 0) / parseInt(limit))
      },
      stats: {
        verified_count: verifiedCount || 0,
        pending_reenroll: 0,
        total_records: totalRecords || 0,
        avg_quality: avgQualityScore
      }
    });
    
  } catch (error) {
    console.error("Face management error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== DEBUG: GET FULL FACE DATA FOR USER ====================
app.get("/api/admin/debug/face-data/:userId", authenticate, authorizeAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    
    console.log(`[DEBUG] Fetching face data for user: ${userId}`);
    
    // 1. Get user basic info
    const { data: user, error: userError } = await supabase
      .from("users")
      .select(`
        id,
        email,
        first_name,
        last_name,
        face_verified,
        face_embedding,
        face_quality_score,
        face_verification_date,
        face_embedding_version,
        created_at
      `)
      .eq("id", userId)
      .single();
    
    if (userError) {
      console.error("User fetch error:", userError);
      return res.status(404).json({ error: "User not found", details: userError });
    }
    
    // 2. Get all face descriptors
    const { data: descriptors, error: descError } = await supabase
      .from("face_descriptors")
      .select(`
        id,
        descriptor,
        is_primary,
        is_active,
        quality_score,
        version,
        created_at,
        updated_at
      `)
      .eq("user_id", userId)
      .order("is_primary", { ascending: false })
      .order("created_at", { ascending: true });
    
    if (descError) {
      console.error("Descriptors fetch error:", descError);
    }
    
    // 3. Analyze user's face_embedding
    const analyzeDescriptor = (desc) => {
      if (!desc) return { exists: false };
      
      const result = {
        exists: true,
        type: typeof desc,
        is_128_array: false,
        array_length: 0,
        first_few_values: null,
        structure: null
      };
      
      // Handle different types
      if (typeof desc === 'string') {
        try {
          const parsed = JSON.parse(desc);
          if (Array.isArray(parsed)) {
            result.is_128_array = parsed.length === 128;
            result.array_length = parsed.length;
            if (result.is_128_array) {
              result.first_few_values = parsed.slice(0, 5);
            }
          } else if (parsed && typeof parsed === 'object') {
            result.structure = Object.keys(parsed);
            if (parsed.vector && Array.isArray(parsed.vector)) {
              result.is_128_array = parsed.vector.length === 128;
              result.array_length = parsed.vector.length;
              if (result.is_128_array) {
                result.first_few_values = parsed.vector.slice(0, 5);
              }
            }
          }
        } catch (e) {}
      }
      
      if (typeof desc === 'object' && desc !== null) {
        result.structure = Object.keys(desc);
        if (desc.vector && Array.isArray(desc.vector)) {
          result.is_128_array = desc.vector.length === 128;
          result.array_length = desc.vector.length;
          if (result.is_128_array) {
            result.first_few_values = desc.vector.slice(0, 5);
          }
        } else if (desc.descriptor && Array.isArray(desc.descriptor)) {
          result.is_128_array = desc.descriptor.length === 128;
          result.array_length = desc.descriptor.length;
          if (result.is_128_array) {
            result.first_few_values = desc.descriptor.slice(0, 5);
          }
        } else if (Array.isArray(desc)) {
          result.is_128_array = desc.length === 128;
          result.array_length = desc.length;
          if (result.is_128_array) {
            result.first_few_values = desc.slice(0, 5);
          }
        }
      }
      
      return result;
    };
    
    // Analyze user's face_embedding
    const userEmbeddingAnalysis = analyzeDescriptor(user.face_embedding);
    
    // Analyze each descriptor
    const descriptorsAnalysis = (descriptors || []).map(desc => ({
      id: desc.id,
      is_primary: desc.is_primary,
      is_active: desc.is_active,
      quality_score: desc.quality_score,
      version: desc.version,
      created_at: desc.created_at,
      analysis: analyzeDescriptor(desc.descriptor)
    }));
    
    // Build recommendation
    let recommendation = "";
    let canVerify = false;
    let needsSync = false;
    
    if (userEmbeddingAnalysis.is_128_array) {
      recommendation = "✅ User has valid face descriptor in users table. Face verification should work.";
      canVerify = true;
    } else if (descriptorsAnalysis.some(d => d.analysis.is_128_array)) {
      recommendation = "⚠️ User has valid face descriptor in face_descriptors table but NOT in users table. Run sync to fix.";
      canVerify = true;
      needsSync = true;
    } else if (descriptorsAnalysis.length > 0) {
      recommendation = "❌ User has face descriptors but none are valid 128-length arrays. Data format is incorrect.";
      canVerify = false;
    } else {
      recommendation = "❌ No face data found for this user. User needs to complete face registration.";
      canVerify = false;
    }
    
    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: `${user.first_name} ${user.last_name}`,
        face_verified: user.face_verified,
        face_quality_score: user.face_quality_score,
        face_verification_date: user.face_verification_date,
        face_embedding_version: user.face_embedding_version || 0
      },
      user_face_embedding: {
        exists: !!user.face_embedding,
        analysis: userEmbeddingAnalysis,
        raw_preview: user.face_embedding ? JSON.stringify(user.face_embedding).substring(0, 200) : null
      },
      descriptors_count: descriptors?.length || 0,
      descriptors: descriptorsAnalysis,
      verification_status: {
        can_verify: canVerify,
        recommendation: recommendation,
        needs_sync: needsSync,
        needs_registration: descriptorsAnalysis.length === 0
      }
    });
    
  } catch (error) {
    console.error("Debug face data error:", error);
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});

// ==================== SYNC FACE DATA FROM DESCRIPTORS TO USERS TABLE ====================
app.post("/api/admin/debug/sync-face-data/:userId", authenticate, authorizeAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    
    console.log(`[SYNC] Syncing face data for user: ${userId}`);
    
    // Find the best descriptor (primary first, then any active, then any)
    const { data: descriptors, error: fetchError } = await supabase
      .from("face_descriptors")
      .select("descriptor, is_primary, quality_score")
      .eq("user_id", userId)
      .eq("is_active", true)
      .order("is_primary", { ascending: false })
      .order("quality_score", { ascending: false });
    
    if (fetchError || !descriptors || descriptors.length === 0) {
      return res.status(404).json({ error: "No face descriptors found for this user" });
    }
    
    let bestVector = null;
    let bestQuality = 0;
    
    for (const desc of descriptors) {
      let vector = null;
      
      // Try to extract vector from different formats
      if (desc.descriptor) {
        // Format: { vector: [...] }
        if (desc.descriptor.vector && Array.isArray(desc.descriptor.vector) && desc.descriptor.vector.length === 128) {
          vector = desc.descriptor.vector;
        }
        // Format: { descriptor: [...] }
        else if (desc.descriptor.descriptor && Array.isArray(desc.descriptor.descriptor) && desc.descriptor.descriptor.length === 128) {
          vector = desc.descriptor.descriptor;
        }
        // Format: direct array
        else if (Array.isArray(desc.descriptor) && desc.descriptor.length === 128) {
          vector = desc.descriptor;
        }
        // Format: string that parses to array
        else if (typeof desc.descriptor === 'string') {
          try {
            const parsed = JSON.parse(desc.descriptor);
            if (Array.isArray(parsed) && parsed.length === 128) {
              vector = parsed;
            } else if (parsed.vector && Array.isArray(parsed.vector) && parsed.vector.length === 128) {
              vector = parsed.vector;
            }
          } catch (e) {}
        }
      }
      
      if (vector) {
        bestVector = vector;
        bestQuality = desc.quality_score || 0;
        break; // Use the first valid one (already ordered by primary then quality)
      }
    }
    
    if (!bestVector) {
      return res.status(400).json({ 
        error: "No valid 128-length face vector found in descriptors",
        debug: descriptors.map(d => ({
          has_descriptor: !!d.descriptor,
          type: typeof d.descriptor,
          keys: d.descriptor ? Object.keys(d.descriptor) : []
        }))
      });
    }
    
    // Get current version
    const { data: currentUser } = await supabase
      .from("users")
      .select("face_embedding_version")
      .eq("id", userId)
      .single();
    
    const newVersion = (currentUser?.face_embedding_version || 0) + 1;
    
    // Update users table
    const { error: updateError } = await supabase
      .from("users")
      .update({
        face_embedding: bestVector,
        face_verified: true,
        face_quality_score: bestQuality || 0.8,
        face_embedding_version: newVersion,
        face_verification_date: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq("id", userId);
    
    if (updateError) throw updateError;
    
    // Log the sync action
    await supabase.from("admin_actions").insert({
      admin_id: req.user.id,
      action_type: "sync_face_data",
      target_user_id: userId,
      details: {
        vector_length: bestVector.length,
        quality_score: bestQuality,
        version: newVersion
      },
      ip_address: req.ip,
      created_at: new Date().toISOString()
    });
    
    console.log(`[SYNC] Successfully synced face data for user ${userId}, version ${newVersion}`);
    
    res.json({
      success: true,
      message: "Face data synced successfully",
      vector_length: bestVector.length,
      vector_preview: bestVector.slice(0, 10),
      version: newVersion
    });
    
  } catch (error) {
    console.error("Sync face data error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== GET USER FACE IMAGES ====================
app.get("/api/admin/users/:userId/face-images", authenticate, authorizeAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    
    console.log(`[FaceImages] Fetching face images for user: ${userId}`);
    
    const { data: descriptors, error } = await supabase
      .from("face_descriptors")
      .select("descriptor, is_primary, quality_score, created_at")
      .eq("user_id", userId)
      .eq("is_active", true)
      .order("is_primary", { ascending: false })
      .order("created_at", { ascending: true });
    
    if (error) throw error;
    
    const images = (descriptors || []).map((desc, index) => {
      let imageData = null;
      let angle = null;
      
      // Extract image from different formats
      if (desc.descriptor) {
        if (desc.descriptor.image) {
          imageData = desc.descriptor.image;
          angle = desc.descriptor.angle;
        } else if (typeof desc.descriptor === 'string' && desc.descriptor.startsWith('data:image')) {
          imageData = desc.descriptor;
        }
      }
      
      return {
        image: imageData,
        angle: angle || index + 1,
        is_primary: desc.is_primary || false,
        quality_score: desc.quality_score,
        created_at: desc.created_at
      };
    }).filter(img => img.image); // Only return entries with actual images
    
    res.json({ images });
    
  } catch (error) {
    console.error("Get face images error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== TEST ENDPOINT FOR CURRENT USER (DEBUG) ====================
app.get("/api/user/debug-my-face", authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    
    console.log(`[DEBUG-ME] User ${userId} debugging their own face data`);
    
    // Get from users table
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("id, email, first_name, last_name, face_verified, face_embedding, face_quality_score")
      .eq("id", userId)
      .single();
    
    if (userError) {
      return res.status(404).json({ error: "User not found", details: userError });
    }
    
    // Get from face_descriptors
    const { data: descriptors, error: descError } = await supabase
      .from("face_descriptors")
      .select("id, is_primary, is_active, quality_score")
      .eq("user_id", userId)
      .eq("is_active", true);
    
    // Analyze face_embedding
    let hasValidVector = false;
    let vectorLength = 0;
    
    if (user.face_embedding) {
      try {
        let embedding = user.face_embedding;
        if (typeof embedding === 'string') embedding = JSON.parse(embedding);
        if (Array.isArray(embedding)) {
          vectorLength = embedding.length;
          hasValidVector = embedding.length === 128;
        } else if (embedding.vector && Array.isArray(embedding.vector)) {
          vectorLength = embedding.vector.length;
          hasValidVector = embedding.vector.length === 128;
        }
      } catch (e) {}
    }
    
    res.json({
      user_id: userId,
      email: user.email,
      name: `${user.first_name} ${user.last_name}`,
      face_verified: user.face_verified,
      has_face_embedding: !!user.face_embedding,
      has_valid_128_vector: hasValidVector,
      vector_length: vectorLength,
      face_quality_score: user.face_quality_score,
      descriptors_count: descriptors?.length || 0,
      can_verify: hasValidVector,
      message: hasValidVector 
        ? "✅ Your face data is valid. Verification should work."
        : "❌ Your face data is invalid or missing. Please contact support."
    });
    
  } catch (error) {
    console.error("Debug my face error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== FIX MISSING FACE DATA (Admin Utility) ====================
app.post("/api/admin/fix-missing-face-data", authenticate, authorizeAdmin, async (req, res) => {
  try {
    // Find users who have face_descriptors but no face_embedding in users table
    const { data: usersWithDescriptors, error: fetchError } = await supabase
      .from("face_descriptors")
      .select("user_id")
      .eq("is_active", true)
      .not("descriptor", "is", null);
    
    if (fetchError) throw fetchError;
    
    const uniqueUserIds = [...new Set(usersWithDescriptors.map(u => u.user_id))];
    let fixed = 0;
    let failed = 0;
    
    for (const userId of uniqueUserIds) {
      try {
        // Get the user's current face_embedding status
        const { data: user } = await supabase
          .from("users")
          .select("face_embedding")
          .eq("id", userId)
          .single();
        
        // Skip if already has face_embedding
        if (user?.face_embedding) continue;
        
        // Get best descriptor
        const { data: descriptors } = await supabase
          .from("face_descriptors")
          .select("descriptor, quality_score")
          .eq("user_id", userId)
          .eq("is_active", true)
          .order("quality_score", { ascending: false })
          .limit(1);
        
        if (descriptors && descriptors.length > 0) {
          let vector = null;
          const desc = descriptors[0].descriptor;
          
          if (desc.vector && Array.isArray(desc.vector) && desc.vector.length === 128) {
            vector = desc.vector;
          } else if (desc.descriptor && Array.isArray(desc.descriptor) && desc.descriptor.length === 128) {
            vector = desc.descriptor;
          } else if (Array.isArray(desc) && desc.length === 128) {
            vector = desc;
          }
          
          if (vector) {
            await supabase
              .from("users")
              .update({
                face_embedding: vector,
                face_verified: true,
                face_quality_score: descriptors[0].quality_score || 0.8,
                updated_at: new Date().toISOString()
              })
              .eq("id", userId);
            fixed++;
          }
        }
      } catch (err) {
        console.error(`Failed to fix user ${userId}:`, err);
        failed++;
      }
    }
    
    res.json({
      success: true,
      message: `Fixed ${fixed} users, failed ${failed}`,
      fixed,
      failed,
      total_users_processed: uniqueUserIds.length
    });
    
  } catch (error) {
    console.error("Fix missing face data error:", error);
    res.status(500).json({ error: error.message });
  }
});
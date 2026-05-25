// Store face data - PRODUCTION VERSION (FIXED)
if (face_images && face_images.length > 0) {
  console.log(`Processing ${face_images.length} face images for user ${user.id}`);
  
  // IMPORTANT: Get face descriptors from request - these are the 128-number vectors
  // If not provided, we'll generate them or store only images
  const faceDescriptorVectors = req.body.face_descriptors || [];
  console.log(`Received ${faceDescriptorVectors.length} face descriptor vectors`);
  
  let bestImage = null;
  let bestVector = null;
  let bestQuality = 0;
  
  for (let i = 0; i < face_images.length; i++) {
    const image = face_images[i];
    const vector = faceDescriptorVectors[i] || null;
    const quality = req.body.face_quality_scores?.[i] || 0.5;
    
    console.log(`Processing image ${i + 1}: has_vector=${!!vector}, vector_length=${vector?.length || 0}`);
    
    // Create the descriptor object
    const descriptorData = {
      image: image,
      angle: i,
      timestamp: new Date().toISOString()
    };
    
    // Add vector if available
    if (vector && Array.isArray(vector) && vector.length === 128) {
      descriptorData.vector = vector;
      console.log(`✅ Image ${i + 1} has valid vector of length ${vector.length}`);
    } else {
      console.log(`⚠️ Image ${i + 1} has NO valid vector`);
    }
    
    // Store in face_descriptors table
    const { error: insertError, data: insertedData } = await supabase
      .from("face_descriptors")
      .insert({
        user_id: user.id,
        descriptor: descriptorData,
        version: 1,
        is_primary: false,
        is_active: true,
        quality_score: quality,
        created_at: new Date().toISOString()
      })
      .select();
    
    if (insertError) {
      console.error(`❌ Failed to insert face descriptor ${i + 1}:`, insertError);
    } else {
      console.log(`✅ Successfully inserted face descriptor ${i + 1}`);
      
      // Track the best quality one
      if (vector && (quality > bestQuality || (!bestVector && vector))) {
        bestQuality = quality;
        bestImage = image;
        bestVector = vector;
      }
    }
  }
  
  // Set the best quality image as PRIMARY
  if (bestVector) {
    console.log(`Setting primary descriptor with vector length ${bestVector.length}`);
    
    // Find the record with the best vector and set as primary
    const { data: bestRecord, error: findError } = await supabase
      .from("face_descriptors")
      .select("id")
      .eq("user_id", user.id)
      .contains("descriptor->>vector", JSON.stringify(bestVector))
      .single();
    
    if (bestRecord) {
      await supabase
        .from("face_descriptors")
        .update({
          is_primary: true,
          quality_score: bestQuality,
          verified_at: new Date().toISOString()
        })
        .eq("id", bestRecord.id);
      console.log(`✅ Set primary descriptor: ${bestRecord.id}`);
    }
    
    // Store in users table for ultra-fast access
    const { error: updateUserError } = await supabase
      .from("users")
      .update({
        face_embedding: bestVector,
        face_verified: true,
        face_quality_score: bestQuality,
        face_verification_date: new Date().toISOString(),
        face_version: 1
      })
      .eq("id", user.id);
    
    if (updateUserError) {
      console.error("❌ Failed to update user with face_embedding:", updateUserError);
    } else {
      console.log("✅ Successfully updated users table with face_embedding");
    }
  } else {
    console.warn("⚠️ No valid face vectors found during registration");
    
    // Even without vectors, still mark as verified? No - only if we have vectors
    // But update to show we have images
    await supabase
      .from("users")
      .update({
        face_verified: false, // Don't mark as verified without vectors
        face_verification_date: null
      })
      .eq("id", user.id);
  }
}
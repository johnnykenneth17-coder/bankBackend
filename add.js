// Get single user details (admin) - FIXED with face images
app.get(
  "/api/admin/users/:userId",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { userId } = req.params;

      // Get user with all fields
      const { data: user, error: userError } = await supabase
        .from("users")
        .select(`
          id,
          email,
          first_name,
          last_name,
          middle_name,
          phone,
          date_of_birth,
          age,
          gender,
          marital_status,
          occupation,
          referral_code,
          address,
          city,
          state,
          country,
          postal_code,
          identification_type,
          identification_number,
          security_question_1,
          security_question_2,
          role,
          kyc_status,
          is_active,
          is_frozen,
          freeze_reason,
          two_factor_enabled,
          face_verified,
          face_quality_score,
          face_embedding,
          created_at,
          updated_at,
          last_login
        `)
        .eq("id", userId)
        .single();

      if (userError || !user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Get accounts
      const { data: accounts } = await supabase
        .from("accounts")
        .select("*")
        .eq("user_id", userId);

      // Get cards
      const { data: cards } = await supabase
        .from("cards")
        .select("*")
        .eq("user_id", userId);

      // Get recent transactions (last 50)
      const { data: transactions } = await supabase
        .from("transactions")
        .select(`
          id,
          transaction_id,
          amount,
          description,
          transaction_type,
          status,
          created_at,
          completed_at,
          from_account_id,
          to_account_id,
          from_user_id,
          to_user_id
        `)
        .or(`from_user_id.eq.${userId},to_user_id.eq.${userId}`)
        .order("created_at", { ascending: false })
        .limit(50);

      // ========== FIXED: Get face descriptors with images ==========
      const { data: faceDescriptors } = await supabase
        .from("face_descriptors")
        .select("id, descriptor, created_at, is_active")
        .eq("user_id", userId)
        .eq("is_active", true)
        .order("created_at", { ascending: true })
        .limit(10);  // Get up to 10 face images

      // Process face descriptors to extract images
      let processedFaceDescriptors = [];
      let firstFaceImage = null;
      
      if (faceDescriptors && faceDescriptors.length > 0) {
        processedFaceDescriptors = faceDescriptors.map(fd => {
          // Check if descriptor contains an image
          let imageData = null;
          if (fd.descriptor) {
            if (typeof fd.descriptor === 'object' && fd.descriptor.image) {
              imageData = fd.descriptor.image;
              if (!firstFaceImage) firstFaceImage = imageData;
            } else if (typeof fd.descriptor === 'string' && fd.descriptor.startsWith('data:image')) {
              imageData = fd.descriptor;
              if (!firstFaceImage) firstFaceImage = imageData;
            }
          }
          return {
            id: fd.id,
            image: imageData,
            created_at: fd.created_at,
            is_active: fd.is_active
          };
        }).filter(fd => fd.image); // Only keep those with images
      }
      
      // Also check if user table has face_embedding with image
      let userFaceImage = null;
      if (user.face_embedding) {
        if (typeof user.face_embedding === 'object' && user.face_embedding.image) {
          userFaceImage = user.face_embedding.image;
        } else if (typeof user.face_embedding === 'string' && user.face_embedding.startsWith('data:image')) {
          userFaceImage = user.face_embedding;
        }
      }
      
      // Use the first available face image
      const finalFaceImage = firstFaceImage || userFaceImage;

      // Combine all data
      const completeUser = {
        ...user,
        accounts: accounts || [],
        cards: cards || [],
        transactions: transactions || [],
        face_descriptors: processedFaceDescriptors,
        face_descriptor_count: processedFaceDescriptors.length,
        face_image: finalFaceImage,  // Add this field for easy access
        has_face_descriptor: processedFaceDescriptors.length > 0,
        has_passcode: !!user.passcode_hash,
      };

      res.json(completeUser);
    } catch (error) {
      console.error("Admin user fetch error:", error);
      res.status(500).json({
        error: "Failed to fetch user",
        details: error.message,
      });
    }
  },
);
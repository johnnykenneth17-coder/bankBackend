// Get face descriptors with images
const { data: faceDescriptors } = await supabase
  .from("face_descriptors")
  .select("descriptor, created_at")
  .eq("user_id", userId)
  .eq("is_active", true)
  .order("created_at", { ascending: true })
  .limit(5);  // Get up to 5 face images

// Include in the response
completeUser.face_descriptors = faceDescriptors || [];
completeUser.face_image = faceDescriptors?.[0]?.descriptor?.image || null;
// ==================== PRODUCTION FACE VERIFICATION API ====================
// Uses face-api.js for reliable face matching without external AI services

const { createCanvas, loadImage } = require('canvas');
const tf = require('@tensorflow/tfjs-node');

// Lazy load face-api.js to avoid blocking startup
let faceapi = null;
let modelsLoaded = false;

async function loadFaceModels() {
    if (modelsLoaded) return true;
    
    try {
        // Dynamic import for face-api.js
        faceapi = require('face-api.js');
        
        // Configure canvas for Node.js
        const { Canvas, Image, ImageData } = require('canvas');
        faceapi.env.monkeyPatch({ Canvas, Image, ImageData });
        
        // Load models from local path (you need to download these files)
        const modelPath = './models/face-api'; // Create this folder
        
        // Check if models exist, if not download them
        const fs = require('fs');
        if (!fs.existsSync(modelPath)) {
            fs.mkdirSync(modelPath, { recursive: true });
            console.log('⚠️ Face models not found. Please download them from:');
            console.log('https://github.com/justadudewhohacks/face-api.js/tree/master/weights');
            console.log(`Place them in: ${modelPath}`);
            return false;
        }
        
        await faceapi.nets.ssdMobilenetv1.loadFromDisk(modelPath);
        await faceapi.nets.faceLandmark68Net.loadFromDisk(modelPath);
        await faceapi.nets.faceRecognitionNet.loadFromDisk(modelPath);
        
        modelsLoaded = true;
        console.log('✅ Face recognition models loaded successfully');
        return true;
    } catch (error) {
        console.error('Failed to load face models:', error);
        return false;
    }
}

// Helper: Convert base64 to tensor
async function base64ToTensor(base64String) {
    const base64Data = base64String.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    const image = await loadImage(buffer);
    const canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    return faceapi?.tf?.browser?.fromPixels(canvas);
}

// Helper: Extract face descriptor from image
async function extractFaceDescriptor(imageBase64) {
    if (!faceapi || !modelsLoaded) {
        await loadFaceModels();
        if (!faceapi || !modelsLoaded) {
            throw new Error('Face recognition not available');
        }
    }
    
    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    const image = await loadImage(buffer);
    const canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    
    const detection = await faceapi.detectSingleFace(canvas)
        .withFaceLandmarks()
        .withFaceDescriptor();
    
    if (!detection) {
        throw new Error('No face detected in image');
    }
    
    return {
        descriptor: Array.from(detection.descriptor),
        landmarks: detection.landmarks,
        detection: detection.detection
    };
}

// Compare two face descriptors using cosine similarity
function compareFaceDescriptors(descriptor1, descriptor2, threshold = 0.6) {
    // Cosine similarity
    let dotProduct = 0;
    let mag1 = 0;
    let mag2 = 0;
    
    for (let i = 0; i < descriptor1.length; i++) {
        dotProduct += descriptor1[i] * descriptor2[i];
        mag1 += descriptor1[i] * descriptor1[i];
        mag2 += descriptor2[i] * descriptor2[i];
    }
    
    mag1 = Math.sqrt(mag1);
    mag2 = Math.sqrt(mag2);
    
    const similarity = dotProduct / (mag1 * mag2);
    const distance = 1 - similarity;
    
    return {
        matched: distance < threshold,
        similarity: similarity,
        distance: distance,
        threshold: threshold
    };
}

// Store face descriptor during registration (already handled in your register route)
// Just ensure the descriptor is stored properly

// === NEW: Simple face verification endpoint ===
app.post("/api/auth/verify-face", authenticate, async (req, res) => {
    try {
        const { face_image, action_type = "verify" } = req.body;
        
        if (!face_image) {
            return res.status(400).json({ error: "Face image required" });
        }
        
        // Load models if not already loaded
        await loadFaceModels();
        
        if (!faceapi || !modelsLoaded) {
            return res.status(503).json({ error: "Face recognition service unavailable" });
        }
        
        // Extract descriptor from submitted image
        const submittedDescriptor = await extractFaceDescriptor(face_image);
        
        // Get stored face descriptors for this user
        const { data: storedFaces, error: faceError } = await supabase
            .from("face_descriptors")
            .select("descriptor, id")
            .eq("user_id", req.user.id)
            .eq("is_active", true);
        
        if (faceError || !storedFaces || storedFaces.length === 0) {
            return res.status(404).json({ 
                error: "No face registered for this account",
                code: "NO_FACE_REGISTERED"
            });
        }
        
        // Compare with stored descriptors
        let bestMatch = null;
        let bestSimilarity = -1;
        
        for (const stored of storedFaces) {
            let storedDescriptor = stored.descriptor;
            
            // Handle different storage formats
            if (storedDescriptor && typeof storedDescriptor === 'object') {
                if (storedDescriptor.descriptor && Array.isArray(storedDescriptor.descriptor)) {
                    storedDescriptor = storedDescriptor.descriptor;
                } else if (storedDescriptor.image && storedDescriptor.descriptor) {
                    storedDescriptor = storedDescriptor.descriptor;
                }
            }
            
            if (storedDescriptor && Array.isArray(storedDescriptor) && storedDescriptor.length > 0) {
                const result = compareFaceDescriptors(
                    submittedDescriptor.descriptor,
                    storedDescriptor,
                    0.6
                );
                
                if (result.similarity > bestSimilarity) {
                    bestSimilarity = result.similarity;
                    bestMatch = result;
                }
            }
        }
        
        if (!bestMatch || !bestMatch.matched) {
            // Log failed attempt
            await supabase.from("security_logs").insert({
                user_id: req.user.id,
                event_type: "face_verification_failed",
                details: { 
                    similarity: bestMatch?.similarity || 0,
                    action_type 
                },
                ip_address: req.ip
            });
            
            return res.status(401).json({
                success: false,
                matched: false,
                error: "Face verification failed",
                similarity: bestMatch?.similarity || 0
            });
        }
        
        // Log successful verification
        await supabase.from("security_logs").insert({
            user_id: req.user.id,
            event_type: "face_verification_success",
            details: { 
                similarity: bestMatch.similarity,
                action_type 
            },
            ip_address: req.ip
        });
        
        res.json({
            success: true,
            matched: true,
            similarity: bestMatch.similarity,
            message: "Face verified successfully"
        });
        
    } catch (error) {
        console.error("Face verification error:", error);
        res.status(500).json({ 
            error: "Face verification failed: " + error.message,
            code: "VERIFICATION_ERROR"
        });
    }
});

// === NEW: Endpoint to check if user has face registered ===
app.get("/api/user/has-face", authenticate, async (req, res) => {
    try {
        const { count, error } = await supabase
            .from("face_descriptors")
            .select("*", { count: "exact", head: true })
            .eq("user_id", req.user.id)
            .eq("is_active", true);
        
        res.json({ 
            has_face: (count || 0) > 0,
            face_count: count || 0
        });
    } catch (error) {
        console.error("Check face error:", error);
        res.json({ has_face: false, face_count: 0 });
    }
});

// === NEW: Endpoint to get face image for user (for admin) ===
app.get("/api/admin/users/:userId/face-image", authenticate, authorizeAdmin, async (req, res) => {
    try {
        const { userId } = req.params;
        
        const { data: faces, error } = await supabase
            .from("face_descriptors")
            .select("descriptor")
            .eq("user_id", userId)
            .eq("is_active", true)
            .limit(1);
        
        if (error || !faces || faces.length === 0) {
            return res.status(404).json({ error: "No face image found" });
        }
        
        let imageData = null;
        const descriptor = faces[0].descriptor;
        
        if (descriptor && typeof descriptor === 'object') {
            if (descriptor.image) {
                imageData = descriptor.image;
            } else if (descriptor.descriptor && descriptor.descriptor.image) {
                imageData = descriptor.descriptor.image;
            }
        }
        
        if (!imageData) {
            return res.status(404).json({ error: "Face image data not found" });
        }
        
        res.json({ face_image: imageData });
    } catch (error) {
        console.error("Get face image error:", error);
        res.status(500).json({ error: "Failed to get face image" });
    }
});
// In index.js - REPLACE the registration success response section

app.post("/api/auth/register", async (req, res) => {
    try {
        // ... (keep all your existing validation and user creation code)
        
        // After user is created successfully, add PROPER SESSION MANAGEMENT
        
        // ========== PRODUCTION SESSION MANAGEMENT FOR REGISTRATION ==========
        
        // Get device info
        const deviceInfo = getDeviceInfo(req);
        const sessionVersion = Math.floor(Date.now() / 1000);
        const sessionId = generateSessionId();
        
        // STEP 1: Get ALL existing active sessions for this user (should be none for new user)
        const { data: existingSessions } = await supabase
            .from("user_sessions")
            .select("id, session_id, device_name, session_token")
            .eq("user_id", user.id)
            .eq("is_active", true);
        
        // STEP 2: Generate token with session info (MATCHES LOGIN FORMAT)
        const token = jwt.sign(
            {
                userId: user.id,
                email: user.email,
                role: user.role,
                sessionId: sessionId,
                sessionVersion: sessionVersion,
                issuedAt: Date.now()
            },
            process.env.JWT_SECRET,
            { expiresIn: process.env.JWT_EXPIRE || "7d" }
        );
        
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 7);
        
        // STEP 3: Insert the new session (MATCHES LOGIN)
        const { error: sessionError } = await supabase
            .from("user_sessions")
            .insert({
                user_id: user.id,
                session_token: token,
                session_id: sessionId,
                device_fingerprint: deviceInfo.device_name,
                device_name: deviceInfo.device_name,
                ip_address: deviceInfo.ip_address,
                user_agent: deviceInfo.user_agent,
                expires_at: expiresAt.toISOString(),
                is_active: true,
                is_current: true,
                session_version: sessionVersion,
                created_at: new Date().toISOString(),
                last_activity: new Date().toISOString()
            });
        
        if (sessionError) {
            console.error("Session insert error during registration:", sessionError);
            // Don't fail registration, just log it
        }
        
        // STEP 4: Update user record with active session (MATCHES LOGIN)
        await supabase
            .from("users")
            .update({
                active_session_id: sessionId,
                last_active_device: deviceInfo.device_name,
                active_session_started_at: new Date().toISOString(),
                last_login: new Date().toISOString(),
                session_version: sessionVersion
            })
            .eq("id", user.id);
        
        // STEP 5: Invalidate any existing sessions (should be none, but safe)
        if (existingSessions && existingSessions.length > 0) {
            console.log(`Invalidating ${existingSessions.length} existing session(s) for new user ${user.id}`);
            
            await supabase
                .from("user_sessions")
                .update({
                    is_active: false,
                    is_current: false,
                    invalidated_reason: `New registration from ${deviceInfo.device_name}`,
                    expires_at: new Date().toISOString()
                })
                .in("id", existingSessions.map(s => s.id));
        }
        
        // STEP 6: Log successful registration
        await logSecurityEvent(user.id, "user_registered", {
            ip: req.ip,
            device: deviceInfo.device_name,
            session_id: sessionId
        });
        
        // Return response with token and session info
        res.status(201).json({
            message: "User created successfully",
            token: token,
            session: {
                id: sessionId,
                device: deviceInfo.device_name,
                logged_in_at: new Date().toISOString()
            },
            user: {
                id: user.id,
                email: user.email,
                first_name: user.first_name,
                last_name: user.last_name,
                middle_name: user.middle_name,
                role: user.role,
                phone: user.phone,
                country: user.country,
                state: user.state,
                city: user.city,
                age: user.age,
                gender: user.gender,
                marital_status: user.marital_status,
                occupation: user.occupation,
                has_passcode: !!user.passcode_hash,
                face_verified: user.face_verified,
                face_images_count: face_images ? face_images.length : 0
            }
        });
        
    } catch (error) {
        console.error("Registration error:", error);
        res.status(500).json({ error: "Registration failed: " + error.message });
    }
});
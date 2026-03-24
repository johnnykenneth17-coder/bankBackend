// Register - Updated version with face verification
app.post("/api/auth/register", async (req, res) => {
    try {
        const { 
            email, 
            password, 
            first_name, 
            last_name, 
            phone,
            country,
            city,
            address,
            security_question_1,
            security_answer_1,
            security_question_2,
            security_answer_2,
            face_image
        } = req.body;

        // Check if user exists
        const { data: existingUser } = await supabase
            .from("users")
            .select("email")
            .eq("email", email)
            .single();

        if (existingUser) {
            return res.status(400).json({ error: "Email already registered" });
        }

        // Validate face image
        if (!face_image) {
            return res.status(400).json({ error: "Face verification required" });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Create user
        const { data: user, error } = await supabase
            .from("users")
            .insert({
                email,
                password_hash: hashedPassword,
                first_name,
                last_name,
                phone,
                country,
                city,
                address,
                security_question_1,
                security_answer_1: await bcrypt.hash(security_answer_1.toLowerCase(), 10),
                security_question_2,
                security_answer_2: await bcrypt.hash(security_answer_2.toLowerCase(), 10),
                face_image: face_image, // Store base64 image
                face_verified: true, // Auto-verify for now, you can add actual face detection
                face_verification_date: new Date(),
                role: "user",
                kyc_status: "pending"
            })
            .select()
            .single();

        if (error) throw error;

        // Create account for user
        await supabase.from("accounts").insert({
            user_id: user.id,
            account_type: "checking",
            currency: "USD",
            balance: 0.00,
            available_balance: 0.00,
        });

        // Generate token
        const token = jwt.sign(
            { userId: user.id, email: user.email, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: process.env.JWT_EXPIRE },
        );

        res.status(201).json({
            message: "User created successfully",
            token,
            user: {
                id: user.id,
                email: user.email,
                first_name: user.first_name,
                last_name: user.last_name,
                role: user.role,
                face_image: user.face_image
            },
        });
    } catch (error) {
        console.error("Registration error:", error);
        res.status(500).json({ error: "Registration failed" });
    }
});
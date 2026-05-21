// ==================== ACCOUNT TIER MANAGEMENT ====================

// Get user's current tier and limits
app.get("/api/user/tier-info", authenticate, async (req, res) => {
    try {
        // Get user's current tier
        const { data: user, error: userError } = await supabase
            .from("users")
            .select("account_tier, email_verified, phone_verified, identification_type, identification_number")
            .eq("id", req.user.id)
            .single();

        if (userError) throw userError;

        // Get tier limits
        const { data: limits, error: limitsError } = await supabase
            .from("account_tier_limits")
            .select("*")
            .eq("tier", user.account_tier)
            .single();

        if (limitsError) throw limitsError;

        // Check if user is eligible for next tier
        const nextTier = user.account_tier + 1;
        let nextTierRequirements = null;
        let canUpgrade = false;
        let upgradeRequirements = [];

        if (nextTier <= 3) {
            const { data: nextLimits } = await supabase
                .from("account_tier_limits")
                .select("*")
                .eq("tier", nextTier)
                .single();

            if (nextLimits) {
                nextTierRequirements = nextLimits;
                
                // Check requirements for next tier
                if (nextLimits.requires_bvn_nin) {
                    const hasValidId = user.identification_type && 
                        (user.identification_type.toLowerCase() === 'nin' || 
                         user.identification_type.toLowerCase() === 'bvn') &&
                        user.identification_number;
                    upgradeRequirements.push({
                        requirement: "BVN/NIN Verification",
                        met: !!hasValidId,
                        action: "provide_id"
                    });
                }
                
                if (nextLimits.requires_email_verification) {
                    upgradeRequirements.push({
                        requirement: "Email Verification",
                        met: user.email_verified || false,
                        action: "verify_email"
                    });
                }
                
                if (nextLimits.requires_address_proof) {
                    const { data: addressProof } = await supabase
                        .from("users")
                        .select("address_proof_status")
                        .eq("id", req.user.id)
                        .single();
                    upgradeRequirements.push({
                        requirement: "Proof of Address",
                        met: addressProof?.address_proof_status === "verified",
                        action: "upload_address"
                    });
                }
                
                canUpgrade = upgradeRequirements.every(r => r.met === true);
            }
        }

        // Get total user balance
        const { data: accounts } = await supabase
            .from("accounts")
            .select("balance")
            .eq("user_id", req.user.id);
        
        const totalBalance = accounts?.reduce((sum, acc) => sum + (acc.balance || 0), 0) || 0;

        // Check if balance exceeds current tier limit
        const exceedsBalanceLimit = totalBalance > limits.max_balance;

        // Get today's total transfers
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const { data: todayTransfers } = await supabase
            .from("transactions")
            .select("amount")
            .eq("from_user_id", req.user.id)
            .eq("status", "completed")
            .gte("created_at", today.toISOString());
        
        const todayTransferred = todayTransfers?.reduce((sum, t) => sum + t.amount, 0) || 0;
        const remainingDailyLimit = Math.max(0, limits.daily_transfer_limit - todayTransferred);

        res.json({
            success: true,
            current_tier: user.account_tier,
            tier_name: limits.tier_name,
            limits: {
                max_balance: limits.max_balance,
                daily_transfer_limit: limits.daily_transfer_limit,
                single_transfer_limit: limits.single_transfer_limit,
                monthly_transfer_limit: limits.monthly_transfer_limit
            },
            usage: {
                total_balance: totalBalance,
                today_transferred: todayTransferred,
                remaining_daily_limit: remainingDailyLimit,
                exceeds_balance_limit: exceedsBalanceLimit
            },
            next_tier: nextTier <= 3 ? {
                tier: nextTier,
                tier_name: nextTierRequirements?.tier_name,
                requirements: upgradeRequirements,
                can_upgrade: canUpgrade
            } : null,
            verification_status: {
                email_verified: user.email_verified || false,
                phone_verified: user.phone_verified || false,
                id_verified: !!(user.identification_type && user.identification_number)
            }
        });
    } catch (error) {
        console.error("Tier info error:", error);
        res.status(500).json({ error: "Failed to get tier information" });
    }
});

// Upgrade account to next tier - Step 1: Submit ID (for tier 1 -> tier 2)
app.post("/api/user/upgrade-tier/id", authenticate, async (req, res) => {
    try {
        const { identification_type, identification_number } = req.body;

        if (!identification_type || !identification_number) {
            return res.status(400).json({ error: "Please provide identification type and number" });
        }

        // Validate identification type (only BVN or NIN for upgrade)
        const validTypes = ['nin', 'bvn', 'NIN', 'BVN'];
        if (!validTypes.includes(identification_type.toLowerCase())) {
            return res.status(400).json({ error: "Please provide BVN or NIN for upgrade" });
        }

        // Get current user tier
        const { data: user, error: userError } = await supabase
            .from("users")
            .select("account_tier, email_verified")
            .eq("id", req.user.id)
            .single();

        if (userError) throw userError;

        if (user.account_tier !== 1) {
            return res.status(400).json({ error: "You are not eligible for this upgrade" });
        }

        // Update user with identification
        const { error: updateError } = await supabase
            .from("users")
            .update({
                identification_type: identification_type.toLowerCase(),
                identification_number: identification_number,
                account_tier: 2,
                tier_upgrade_status: 'approved',
                tier_upgrade_requested_at: new Date(),
                updated_at: new Date()
            })
            .eq("id", req.user.id);

        if (updateError) throw updateError;

        // Create upgrade request record
        await supabase.from("tier_upgrade_requests").insert({
            user_id: req.user.id,
            from_tier: 1,
            to_tier: 2,
            status: 'approved',
            identification_type: identification_type.toLowerCase(),
            identification_number: identification_number,
            requested_at: new Date(),
            processed_at: new Date()
        });

        // Create notification
        await supabase.from("notifications").insert({
            user_id: req.user.id,
            title: "Account Upgraded! 🎉",
            message: "Your account has been upgraded to Tier 2 (Verified). You now have higher limits!",
            type: "success",
            created_at: new Date()
        });

        res.json({
            success: true,
            message: "Account upgraded to Tier 2 successfully!",
            next_tier_available: true
        });
    } catch (error) {
        console.error("Tier upgrade ID error:", error);
        res.status(500).json({ error: "Failed to upgrade account" });
    }
});

// Upgrade to Tier 3 - Send email verification OTP
app.post("/api/user/upgrade-tier/send-email-otp", authenticate, async (req, res) => {
    try {
        const { data: user, error: userError } = await supabase
            .from("users")
            .select("account_tier, email, email_verified")
            .eq("id", req.user.id)
            .single();

        if (userError) throw userError;

        if (user.account_tier !== 2) {
            return res.status(400).json({ error: "Invalid tier for upgrade" });
        }

        if (user.email_verified) {
            return res.json({ 
                success: true, 
                already_verified: true,
                message: "Email already verified"
            });
        }

        // Generate OTP
        const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

        // Store OTP
        await supabase.from("otps").insert({
            user_id: req.user.id,
            otp_code: otpCode,
            otp_type: "email_verification",
            expires_at: expiresAt,
            is_used: false
        });

        // Send email
        await transporter.sendMail({
            from: process.env.SMTP_FROM,
            to: user.email,
            subject: "Verify Your Email - FEECENT Account Upgrade",
            html: `
                <h2>Email Verification</h2>
                <p>Your verification code is: <strong style="font-size: 24px;">${otpCode}</strong></p>
                <p>This code expires in 10 minutes.</p>
                <p>Enter this code to verify your email and continue with account upgrade.</p>
            `
        });

        res.json({
            success: true,
            message: "Verification code sent to your email"
        });
    } catch (error) {
        console.error("Send email OTP error:", error);
        res.status(500).json({ error: "Failed to send verification code" });
    }
});

// Verify email OTP for tier 3 upgrade
app.post("/api/user/upgrade-tier/verify-email", authenticate, async (req, res) => {
    try {
        const { otp_code } = req.body;

        if (!otp_code) {
            return res.status(400).json({ error: "Verification code required" });
        }

        // Verify OTP
        const { data: otpRecord, error: otpError } = await supabase
            .from("otps")
            .select("*")
            .eq("user_id", req.user.id)
            .eq("otp_code", otp_code)
            .eq("otp_type", "email_verification")
            .eq("is_used", false)
            .single();

        if (otpError || !otpRecord) {
            return res.status(401).json({ error: "Invalid or expired verification code" });
        }

        if (new Date(otpRecord.expires_at) < new Date()) {
            return res.status(401).json({ error: "Verification code has expired" });
        }

        // Mark OTP as used
        await supabase
            .from("otps")
            .update({ is_used: true })
            .eq("id", otpRecord.id);

        // Mark email as verified
        await supabase
            .from("users")
            .update({
                email_verified: true,
                email_verified_at: new Date(),
                updated_at: new Date()
            })
            .eq("id", req.user.id);

        res.json({
            success: true,
            message: "Email verified successfully!"
        });
    } catch (error) {
        console.error("Verify email error:", error);
        res.status(500).json({ error: "Failed to verify email" });
    }
});

// Submit address proof for tier 3 upgrade
app.post("/api/user/upgrade-tier/upload-address", authenticate, async (req, res) => {
    try {
        const { address_image } = req.body;

        if (!address_image) {
            return res.status(400).json({ error: "Address proof image required" });
        }

        // Validate image size (max 2MB)
        const imageSize = Math.ceil(address_image.length * 0.75);
        if (imageSize > 2 * 1024 * 1024) {
            return res.status(400).json({ error: "Image too large. Maximum 2MB." });
        }

        // Update user with address proof
        await supabase
            .from("users")
            .update({
                address_proof_image: address_image,
                address_proof_submitted_at: new Date(),
                address_proof_status: "pending",
                updated_at: new Date()
            })
            .eq("id", req.user.id);

        // Create upgrade request record (pending admin review)
        const { data: existingRequest } = await supabase
            .from("tier_upgrade_requests")
            .select("id")
            .eq("user_id", req.user.id)
            .eq("status", "pending")
            .maybeSingle();

        if (!existingRequest) {
            await supabase.from("tier_upgrade_requests").insert({
                user_id: req.user.id,
                from_tier: 2,
                to_tier: 3,
                status: "pending",
                address_proof_image: address_image,
                requested_at: new Date()
            });
        }

        // Create notification for admin
        const { data: admins } = await supabase
            .from("users")
            .select("id")
            .eq("role", "admin");

        for (const admin of admins || []) {
            await supabase.from("notifications").insert({
                user_id: admin.id,
                title: "New Tier Upgrade Request",
                message: `User ${req.user.first_name} ${req.user.last_name} has requested Tier 3 upgrade. Address proof pending review.`,
                type: "info",
                created_at: new Date()
            });
        }

        // Notify user
        await supabase.from("notifications").insert({
            user_id: req.user.id,
            title: "Address Proof Submitted",
            message: "Your address proof has been submitted for review. Once approved, your account will be upgraded to Tier 3.",
            type: "info",
            created_at: new Date()
        });

        res.json({
            success: true,
            message: "Address proof submitted for review. Please wait for admin approval.",
            pending_approval: true
        });
    } catch (error) {
        console.error("Upload address error:", error);
        res.status(500).json({ error: "Failed to upload address proof" });
    }
});

// Complete tier 3 upgrade (admin approves address proof)
app.post("/api/admin/upgrade-tier/:userId/approve-address", authenticate, authorizeAdmin, async (req, res) => {
    try {
        const { userId } = req.params;

        // Get user
        const { data: user, error: userError } = await supabase
            .from("users")
            .select("account_tier, email_verified, identification_type")
            .eq("id", userId)
            .single();

        if (userError) throw userError;

        if (user.account_tier !== 2) {
            return res.status(400).json({ error: "User is not eligible for Tier 3 upgrade" });
        }

        // Check requirements
        if (!user.email_verified) {
            return res.status(400).json({ error: "User email not verified" });
        }

        const validIdTypes = ['nin', 'bvn'];
        if (!validIdTypes.includes(user.identification_type?.toLowerCase())) {
            return res.status(400).json({ error: "User needs BVN/NIN verification" });
        }

        // Upgrade to tier 3
        await supabase
            .from("users")
            .update({
                account_tier: 3,
                address_proof_status: "verified",
                tier_upgrade_status: "approved",
                updated_at: new Date()
            })
            .eq("id", userId);

        // Update upgrade request
        await supabase
            .from("tier_upgrade_requests")
            .update({
                status: "approved",
                processed_at: new Date(),
                processed_by: req.user.id,
                admin_notes: `Approved by ${req.user.email}`
            })
            .eq("user_id", userId)
            .eq("to_tier", 3)
            .eq("status", "pending");

        // Notify user
        await supabase.from("notifications").insert({
            user_id: userId,
            title: "Account Upgraded to Tier 3! 🚀",
            message: "Congratulations! Your account has been upgraded to Tier 3 (Premium). You now have unlimited transfers!",
            type: "success",
            created_at: new Date()
        });

        res.json({
            success: true,
            message: "User upgraded to Tier 3 successfully"
        });
    } catch (error) {
        console.error("Admin approve tier upgrade error:", error);
        res.status(500).json({ error: "Failed to approve upgrade" });
    }
});

// Check and freeze account if balance exceeds tier limit
async function checkAndFreezeIfBalanceExceeds(userId) {
    try {
        // Get user's tier
        const { data: user, error: userError } = await supabase
            .from("users")
            .select("account_tier, is_frozen")
            .eq("id", userId)
            .single();

        if (userError) return;

        // Get tier limits
        const { data: limits, error: limitsError } = await supabase
            .from("account_tier_limits")
            .select("max_balance")
            .eq("tier", user.account_tier)
            .single();

        if (limitsError) return;

        // Get user's total balance
        const { data: accounts } = await supabase
            .from("accounts")
            .select("balance")
            .eq("user_id", userId);

        const totalBalance = accounts?.reduce((sum, acc) => sum + (acc.balance || 0), 0) || 0;

        // Check if balance exceeds limit
        if (totalBalance > limits.max_balance && !user.is_frozen) {
            await supabase
                .from("users")
                .update({
                    is_frozen: true,
                    freeze_reason: `Your balance (₦${totalBalance.toLocaleString()}) exceeds your Tier ${user.account_tier} limit of ₦${limits.max_balance.toLocaleString()}. Please upgrade your account to continue.`,
                    freeze_reason_type: "balance_exceeded",
                    unfreeze_method: "upgrade",
                    updated_at: new Date()
                })
                .eq("id", userId);

            await supabase.from("notifications").insert({
                user_id: userId,
                title: "Account Frozen - Balance Limit Exceeded",
                message: `Your balance (₦${totalBalance.toLocaleString()}) exceeds your Tier ${user.account_tier} limit of ₦${limits.max_balance.toLocaleString()}. Please upgrade your account to continue using our services.`,
                type: "error",
                created_at: new Date()
            });
        }
        // If balance is back within limit and account was frozen for balance reason, unfreeze
        else if (totalBalance <= limits.max_balance && user.is_frozen && user.freeze_reason_type === "balance_exceeded") {
            await supabase
                .from("users")
                .update({
                    is_frozen: false,
                    freeze_reason: null,
                    freeze_reason_type: null,
                    unfreeze_method: null,
                    updated_at: new Date()
                })
                .eq("id", userId);
        }
    } catch (error) {
        console.error("Balance check error:", error);
    }
}

// Modify transfer route to check daily limits based on tier
// Add this inside the transfer route before processing

// Check tier-based daily limit
async function checkTierTransferLimit(userId, amount) {
    try {
        const { data: user, error: userError } = await supabase
            .from("users")
            .select("account_tier")
            .eq("id", userId)
            .single();

        if (userError) return { allowed: true };

        const { data: limits, error: limitsError } = await supabase
            .from("account_tier_limits")
            .select("daily_transfer_limit, single_transfer_limit")
            .eq("tier", user.account_tier)
            .single();

        if (limitsError) return { allowed: true };

        // Check single transfer limit
        if (amount > limits.single_transfer_limit) {
            return { 
                allowed: false, 
                error: `Single transfer limit for your tier is ₦${limits.single_transfer_limit.toLocaleString()}`,
                limit: limits.single_transfer_limit
            };
        }

        // Get today's total transfers
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        const { data: todayTransfers } = await supabase
            .from("transactions")
            .select("amount")
            .eq("from_user_id", userId)
            .eq("status", "completed")
            .gte("created_at", today.toISOString());

        const todayTotal = todayTransfers?.reduce((sum, t) => sum + t.amount, 0) || 0;
        
        if (todayTotal + amount > limits.daily_transfer_limit) {
            return { 
                allowed: false, 
                error: `Daily transfer limit for your tier is ₦${limits.daily_transfer_limit.toLocaleString()}. You have ₦${(limits.daily_transfer_limit - todayTotal).toLocaleString()} remaining today.`,
                limit: limits.daily_transfer_limit,
                remaining: limits.daily_transfer_limit - todayTotal
            };
        }

        return { allowed: true };
    } catch (error) {
        console.error("Tier limit check error:", error);
        return { allowed: true };
    }
}


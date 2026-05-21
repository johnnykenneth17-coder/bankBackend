// Get user's current tier and limits - SAFE VERSION
app.get("/api/user/tier-info", authenticate, async (req, res) => {
    try {
        // Get user's current tier
        const { data: user, error: userError } = await supabase
            .from("users")
            .select("account_tier, email_verified, phone_verified, identification_type, identification_number")
            .eq("id", req.user.id)
            .single();

        if (userError) {
            console.error("Tier info user error:", userError);
            return res.json({
                success: true,
                current_tier: 1,
                tier_name: "Basic",
                limits: {
                    max_balance: 500000,
                    daily_transfer_limit: 150000,
                    single_transfer_limit: 150000,
                    monthly_transfer_limit: 3000000
                },
                usage: {
                    total_balance: 0,
                    today_transferred: 0,
                    remaining_daily_limit: 150000,
                    exceeds_balance_limit: false
                },
                next_tier: {
                    tier: 2,
                    tier_name: "Verified",
                    requirements: [{ requirement: "BVN/NIN Verification", met: false, action: "provide_id" }],
                    can_upgrade: false
                },
                verification_status: {
                    email_verified: false,
                    phone_verified: false,
                    id_verified: false
                }
            });
        }

        const userTier = user?.account_tier || 1;
        
        // Get tier limits with fallback
        let limits;
        const { data: tierLimits, error: limitsError } = await supabase
            .from("account_tier_limits")
            .select("*")
            .eq("tier", userTier)
            .single();
        
        if (limitsError || !tierLimits) {
            const fallbackLimits = {
                1: { max_balance: 500000, daily_transfer_limit: 150000, single_transfer_limit: 150000, monthly_transfer_limit: 3000000, tier_name: "Basic" },
                2: { max_balance: 800000, daily_transfer_limit: 250000, single_transfer_limit: 250000, monthly_transfer_limit: 5000000, tier_name: "Verified" },
                3: { max_balance: 999999999, daily_transfer_limit: 999999999, single_transfer_limit: 999999999, monthly_transfer_limit: 999999999, tier_name: "Premium" }
            };
            limits = fallbackLimits[userTier] || fallbackLimits[1];
        } else {
            limits = tierLimits;
        }

        // Get user's total balance
        const { data: accounts } = await supabase
            .from("accounts")
            .select("balance")
            .eq("user_id", req.user.id);
        
        const totalBalance = accounts?.reduce((sum, acc) => sum + (acc.balance || 0), 0) || 0;

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
        
        const exceedsBalanceLimit = totalBalance > limits.max_balance;

        // Check next tier requirements
        const nextTier = userTier + 1;
        let nextTierRequirements = null;
        let canUpgrade = false;
        let upgradeRequirements = [];

        if (nextTier <= 3) {
            let nextLimits;
            const { data: nextLimitsData } = await supabase
                .from("account_tier_limits")
                .select("*")
                .eq("tier", nextTier)
                .single();
            
            if (nextLimitsData) {
                nextLimits = nextLimitsData;
            } else {
                const fallbackNext = {
                    2: { max_balance: 800000, daily_transfer_limit: 250000, single_transfer_limit: 250000, monthly_transfer_limit: 5000000, tier_name: "Verified", requires_bvn_nin: true },
                    3: { max_balance: 999999999, daily_transfer_limit: 999999999, single_transfer_limit: 999999999, monthly_transfer_limit: 999999999, tier_name: "Premium", requires_bvn_nin: true, requires_address_proof: true, requires_email_verification: true }
                };
                nextLimits = fallbackNext[nextTier];
            }
            
            if (nextLimits) {
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
                    upgradeRequirements.push({
                        requirement: "Proof of Address",
                        met: false,
                        action: "upload_address"
                    });
                }
                
                canUpgrade = upgradeRequirements.every(r => r.met === true);
                nextTierRequirements = {
                    tier: nextTier,
                    tier_name: nextLimits.tier_name,
                    requirements: upgradeRequirements,
                    can_upgrade: canUpgrade
                };
            }
        }

        res.json({
            success: true,
            current_tier: userTier,
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
            next_tier: nextTierRequirements,
            verification_status: {
                email_verified: user.email_verified || false,
                phone_verified: user.phone_verified || false,
                id_verified: !!(user.identification_type && user.identification_number)
            }
        });
    } catch (error) {
        console.error("Tier info error:", error);
        res.json({
            success: true,
            current_tier: 1,
            tier_name: "Basic",
            limits: {
                max_balance: 500000,
                daily_transfer_limit: 150000,
                single_transfer_limit: 150000,
                monthly_transfer_limit: 3000000
            },
            usage: {
                total_balance: 0,
                today_transferred: 0,
                remaining_daily_limit: 150000,
                exceeds_balance_limit: false
            },
            next_tier: {
                tier: 2,
                tier_name: "Verified",
                requirements: [{ requirement: "BVN/NIN Verification", met: false, action: "provide_id" }],
                can_upgrade: false
            },
            verification_status: {
                email_verified: false,
                phone_verified: false,
                id_verified: false
            }
        });
    }
});
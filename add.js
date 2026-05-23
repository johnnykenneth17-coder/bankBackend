// Update the tier-info response to include pending statuses
// Find this section in your index.js and update it:

app.get("/api/user/tier-info", authenticate, async (req, res) => {
  try {
    // Get user's current tier
    const { data: user, error: userError } = await supabase
      .from("users")
      .select(
        "account_tier, email_verified, phone_verified, identification_type, identification_number, tier_upgrade_status, address_proof_status"
      )
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
          const hasValidId =
            user.identification_type &&
            (user.identification_type.toLowerCase() === "nin" ||
              user.identification_type.toLowerCase() === "bvn") &&
            user.identification_number;
          upgradeRequirements.push({
            requirement: "BVN/NIN Verification",
            met: !!hasValidId,
            action: "provide_id",
          });
        }

        if (nextLimits.requires_email_verification) {
          upgradeRequirements.push({
            requirement: "Email Verification",
            met: user.email_verified || false,
            action: "verify_email",
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
            action: "upload_address",
          });
        }

        canUpgrade = upgradeRequirements.every((r) => r.met === true);
      }
    }

    // Get total user balance
    const { data: accounts } = await supabase
      .from("accounts")
      .select("balance")
      .eq("user_id", req.user.id);

    const totalBalance =
      accounts?.reduce((sum, acc) => sum + (acc.balance || 0), 0) || 0;

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

    const todayTransferred =
      todayTransfers?.reduce((sum, t) => sum + t.amount, 0) || 0;
    const remainingDailyLimit = Math.max(
      0,
      limits.daily_transfer_limit - todayTransferred,
    );

    // ========== IMPROVED: Return pending statuses for frontend ==========
    // Check if user has pending verification
    const hasSubmittedId = !!(user.identification_type && user.identification_number);
    const isIdPending = hasSubmittedId && user.account_tier < 2 && user.tier_upgrade_status === "pending";
    const isAddressPending = user.address_proof_status === "pending";
    const isIdRejected = user.tier_upgrade_status === "rejected";
    const isAddressRejected = user.address_proof_status === "rejected";

    res.json({
      success: true,
      current_tier: user.account_tier,
      tier_name: limits.tier_name,
      limits: {
        max_balance: limits.max_balance,
        daily_transfer_limit: limits.daily_transfer_limit,
        single_transfer_limit: limits.single_transfer_limit,
        monthly_transfer_limit: limits.monthly_transfer_limit,
      },
      usage: {
        total_balance: totalBalance,
        today_transferred: todayTransferred,
        remaining_daily_limit: remainingDailyLimit,
        exceeds_balance_limit: exceedsBalanceLimit,
      },
      next_tier:
        nextTier <= 3
          ? {
              tier: nextTier,
              tier_name: nextTierRequirements?.tier_name,
              requirements: upgradeRequirements,
              can_upgrade: canUpgrade,
            }
          : null,
      verification_status: {
        email_verified: user.email_verified || false,
        phone_verified: user.phone_verified || false,
        id_verified: user.account_tier >= 2,
        // NEW: Pending and rejection statuses
        id_pending: isIdPending,
        address_pending: isAddressPending,
        id_rejected: isIdRejected,
        address_rejected: isAddressRejected,
        id_submitted: hasSubmittedId,
        address_submitted: !!user.address_proof_image,
        rejection_reason: user.upgrade_rejection_reason || null,
      },
    });
  } catch (error) {
    console.error("Tier info error:", error);
    res.status(500).json({ error: "Failed to get tier information" });
  }
});
// ==================== ACCOUNT UPGRADE API ROUTES ====================

// ==================== EMAIL VERIFICATION FOR UPGRADE ====================

// Send email verification OTP for upgrade
app.post(
  "/api/user/upgrade/send-email-otp",
  authenticate,
  checkAccountFrozen,
  async (req, res) => {
    try {
      const userId = req.user.id;
      const userEmail = req.user.email;

      // Check if user already has active upgrade request that is pending
      const { data: existingRequest, error: requestError } = await supabase
        .from("user_upgrade_requests")
        .select("overall_status")
        .eq("user_id", userId)
        .single();

      if (existingRequest && existingRequest.overall_status === "approved") {
        return res
          .status(400)
          .json({ error: "You have already completed all upgrades" });
      }

      // Generate 6-digit OTP
      const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date();
      expiresAt.setMinutes(expiresAt.getMinutes() + 10); // 10 minutes expiry

      // Store OTP in database
      const { data: otpData, error: otpError } = await supabase
        .from("email_verification_otps")
        .insert({
          user_id: userId,
          email: userEmail,
          otp_code: otpCode,
          expires_at: expiresAt.toISOString(),
        })
        .select()
        .single();

      if (otpError) {
        console.error("OTP insert error:", otpError);
        return res
          .status(500)
          .json({ error: "Failed to generate verification code" });
      }

      // In production, send email via email service
      console.log(`Email verification OTP for ${userEmail}: ${otpCode}`);

      // TODO: Implement actual email sending
      // await sendEmail(userEmail, 'Email Verification for Account Upgrade', `Your verification code is: ${otpCode}`);

      res.json({
        success: true,
        message: "Verification code sent to your email",
        request_id: otpData.id,
        expires_in: 600,
      });
    } catch (error) {
      console.error("Send email OTP error:", error);
      res.status(500).json({ error: "Failed to send verification code" });
    }
  },
);

// Resend email verification OTP
app.post(
  "/api/user/upgrade/resend-email-otp",
  authenticate,
  checkAccountFrozen,
  async (req, res) => {
    try {
      const userId = req.user.id;
      const userEmail = req.user.email;

      // Invalidate old unused OTPs
      await supabase
        .from("email_verification_otps")
        .update({ is_used: true })
        .eq("user_id", userId)
        .eq("is_used", false);

      // Generate new OTP
      const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date();
      expiresAt.setMinutes(expiresAt.getMinutes() + 10);

      const { data: otpData, error: otpError } = await supabase
        .from("email_verification_otps")
        .insert({
          user_id: userId,
          email: userEmail,
          otp_code: otpCode,
          expires_at: expiresAt.toISOString(),
        })
        .select()
        .single();

      if (otpError) {
        return res
          .status(500)
          .json({ error: "Failed to generate verification code" });
      }

      console.log(`Resent email verification OTP for ${userEmail}: ${otpCode}`);

      res.json({
        success: true,
        message: "New verification code sent to your email",
        request_id: otpData.id,
      });
    } catch (error) {
      console.error("Resend email OTP error:", error);
      res.status(500).json({ error: "Failed to resend verification code" });
    }
  },
);

// Verify email OTP
app.post(
  "/api/user/upgrade/verify-email",
  authenticate,
  checkAccountFrozen,
  async (req, res) => {
    try {
      const userId = req.user.id;
      const { otp_code } = req.body;

      if (!otp_code) {
        return res.status(400).json({ error: "OTP code is required" });
      }

      // Find valid OTP
      const { data: otpRecord, error: otpError } = await supabase
        .from("email_verification_otps")
        .select("*")
        .eq("user_id", userId)
        .eq("otp_code", otp_code)
        .eq("is_used", false)
        .single();

      if (otpError || !otpRecord) {
        return res
          .status(400)
          .json({ error: "Invalid or expired verification code" });
      }

      // Check expiry
      if (new Date(otpRecord.expires_at) < new Date()) {
        return res.status(400).json({ error: "Verification code has expired" });
      }

      // Mark OTP as used
      await supabase
        .from("email_verification_otps")
        .update({ is_used: true })
        .eq("id", otpRecord.id);

      // Create or update upgrade request
      const { data: existingRequest, error: requestError } = await supabase
        .from("user_upgrade_requests")
        .select("*")
        .eq("user_id", userId)
        .single();

      if (existingRequest) {
        await supabase
          .from("user_upgrade_requests")
          .update({
            email_verified: true,
            email_verified_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", userId);
      } else {
        await supabase.from("user_upgrade_requests").insert({
          user_id: userId,
          email_verified: true,
          email_verified_at: new Date().toISOString(),
          overall_status: "email_verified",
        });
      }

      res.json({
        success: true,
        message: "Email verified successfully",
      });
    } catch (error) {
      console.error("Verify email OTP error:", error);
      res.status(500).json({ error: "Failed to verify email" });
    }
  },
);

// ==================== UPGRADE DOCUMENT SUBMISSION ====================

// Submit upgrade documents (ID and/or Address)
app.post(
  "/api/user/upgrade/submit-documents",
  authenticate,
  checkAccountFrozen,
  async (req, res) => {
    try {
      const userId = req.user.id;
      const { id_document, address_document, id_type, id_number } = req.body;

      // Check if user is already fully upgraded
      const { data: userData } = await supabase
        .from("users")
        .select("account_tier")
        .eq("id", userId)
        .single();

      if (userData && userData.account_tier >= 3) {
        return res
          .status(400)
          .json({ error: "You have already reached the highest tier" });
      }

      // Get or create upgrade request
      let { data: upgradeRequest, error: requestError } = await supabase
        .from("user_upgrade_requests")
        .select("*")
        .eq("user_id", userId)
        .single();

      if (!upgradeRequest) {
        const { data: newRequest, error: createError } = await supabase
          .from("user_upgrade_requests")
          .insert({
            user_id: userId,
            overall_status: "documents_submitted",
          })
          .select()
          .single();

        if (createError) throw createError;
        upgradeRequest = newRequest;
      }

      const results = {};

      // Submit ID document
      if (id_document) {
        // Check if ID document already exists
        const { data: existingIdDoc } = await supabase
          .from("user_upgrade_documents")
          .select("*")
          .eq("user_id", userId)
          .eq("document_type", "id")
          .single();

        const documentData = {
          user_id: userId,
          document_type: "id",
          document_data: id_document,
          id_type: id_type || null,
          id_number: id_number || null,
          status: "pending",
          submitted_at: new Date().toISOString(),
        };

        let idDoc;
        if (existingIdDoc) {
          const { data: updated, error: updateError } = await supabase
            .from("user_upgrade_documents")
            .update(documentData)
            .eq("id", existingIdDoc.id)
            .select()
            .single();

          if (updateError) throw updateError;
          idDoc = updated;
          results.id_document = "updated";
        } else {
          const { data: inserted, error: insertError } = await supabase
            .from("user_upgrade_documents")
            .insert(documentData)
            .select()
            .single();

          if (insertError) throw insertError;
          idDoc = inserted;
          results.id_document = "submitted";
        }

        // Update upgrade request with ID document reference
        await supabase
          .from("user_upgrade_requests")
          .update({
            id_document_id: idDoc.id,
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", userId);
      }

      // Submit Address document
      if (address_document) {
        const { data: existingAddressDoc } = await supabase
          .from("user_upgrade_documents")
          .select("*")
          .eq("user_id", userId)
          .eq("document_type", "address")
          .single();

        const documentData = {
          user_id: userId,
          document_type: "address",
          document_data: address_document,
          status: "pending",
          submitted_at: new Date().toISOString(),
        };

        let addressDoc;
        if (existingAddressDoc) {
          const { data: updated, error: updateError } = await supabase
            .from("user_upgrade_documents")
            .update(documentData)
            .eq("id", existingAddressDoc.id)
            .select()
            .single();

          if (updateError) throw updateError;
          addressDoc = updated;
          results.address_document = "updated";
        } else {
          const { data: inserted, error: insertError } = await supabase
            .from("user_upgrade_documents")
            .insert(documentData)
            .select()
            .single();

          if (insertError) throw insertError;
          addressDoc = inserted;
          results.address_document = "submitted";
        }

        await supabase
          .from("user_upgrade_requests")
          .update({
            address_document_id: addressDoc.id,
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", userId);
      }

      // Update overall status
      const { data: currentDocs } = await supabase
        .from("user_upgrade_documents")
        .select("status")
        .eq("user_id", userId);

      const hasPending = currentDocs?.some((doc) => doc.status === "pending");
      const overallStatus = hasPending
        ? "documents_pending"
        : "documents_submitted";

      await supabase
        .from("user_upgrade_requests")
        .update({
          overall_status: overallStatus,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId);

      // Create notification for user
      await supabase.from("notifications").insert({
        user_id: userId,
        title: "Upgrade Documents Submitted",
        message:
          "Your upgrade documents have been submitted for review. You will be notified once approved.",
        type: "info",
        created_at: new Date().toISOString(),
      });

      // Log admin action
      await supabase.from("admin_actions").insert({
        admin_id: userId,
        action_type: "submit_upgrade_documents",
        target_user_id: userId,
        details: results,
        ip_address: req.ip,
        created_at: new Date().toISOString(),
      });

      res.json({
        success: true,
        message: "Documents submitted for review",
        results: results,
      });
    } catch (error) {
      console.error("Submit upgrade documents error:", error);
      res.status(500).json({ error: "Failed to submit documents" });
    }
  },
);

// Get upgrade status for user
app.get(
  "/api/user/upgrade/status",
  authenticate,
  checkAccountFrozen,
  async (req, res) => {
    try {
      const userId = req.user.id;

      // Get user tier
      const { data: user, error: userError } = await supabase
        .from("users")
        .select("account_tier")
        .eq("id", userId)
        .single();

      if (userError) throw userError;

      // Get upgrade request
      const { data: upgradeRequest, error: requestError } = await supabase
        .from("user_upgrade_requests")
        .select("*")
        .eq("user_id", userId)
        .single();

      // Get documents
      const { data: documents, error: docError } = await supabase
        .from("user_upgrade_documents")
        .select("*")
        .eq("user_id", userId);

      // Check if email is verified (if upgrade request exists)
      const emailVerified = upgradeRequest?.email_verified || false;

      // Get document statuses
      const idDoc = documents?.find((d) => d.document_type === "id");
      const addressDoc = documents?.find((d) => d.document_type === "address");

      const idStatus = idDoc?.status || "not_submitted";
      const addressStatus = addressDoc?.status || "not_submitted";

      // Determine if can upgrade to next tier
      let canUpgradeToTier2 = false;
      let canUpgradeToTier3 = false;

      if (user.account_tier === 1) {
        canUpgradeToTier2 = true;
        canUpgradeToTier3 = true;
      } else if (user.account_tier === 2) {
        canUpgradeToTier3 = true;
      }

      // Check if documents are approved
      const isIdApproved = idStatus === "approved";
      const isAddressApproved = addressStatus === "approved";

      // Check if both documents are approved (for tier 3)
      const bothApproved = isIdApproved && isAddressApproved;

      res.json({
        current_tier: user.account_tier || 1,
        email_verified: emailVerified,
        id_status: idStatus,
        address_status: addressStatus,
        id_rejection_reason: idDoc?.rejection_reason || null,
        address_rejection_reason: addressDoc?.rejection_reason || null,
        can_upgrade_to_tier2: canUpgradeToTier2,
        can_upgrade_to_tier3: canUpgradeToTier3,
        has_pending: idStatus === "pending" || addressStatus === "pending",
        id_approved: isIdApproved,
        address_approved: isAddressApproved,
        both_approved: bothApproved,
        upgrade_request: upgradeRequest,
      });
    } catch (error) {
      console.error("Get upgrade status error:", error);
      res.status(500).json({ error: "Failed to get upgrade status" });
    }
  },
);

// ==================== ADMIN UPGRADE DOCUMENT REVIEW ROUTES ====================

// Get all upgrade requests (admin only)
app.get(
  "/api/admin/upgrade-requests",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const {
        page = 1,
        limit = 20,
        status = "all",
        document_type = "all",
      } = req.query;
      const offset = (parseInt(page) - 1) * parseInt(limit);

      let query = supabase.from("user_upgrade_documents").select(
        `
                *,
                users:user_id (
                    id,
                    first_name,
                    last_name,
                    email,
                    account_tier,
                    phone
                )
            `,
        { count: "exact" },
      );

      if (status !== "all") {
        query = query.eq("status", status);
      }

      if (document_type !== "all") {
        query = query.eq("document_type", document_type);
      }

      const {
        data: documents,
        error,
        count,
      } = await query
        .order("submitted_at", { ascending: false })
        .range(offset, offset + parseInt(limit) - 1);

      if (error) throw error;

      // Get stats
      const { data: pendingIdDocs } = await supabase
        .from("user_upgrade_documents")
        .select("id", { count: "exact", head: true })
        .eq("document_type", "id")
        .eq("status", "pending");

      const { data: pendingAddressDocs } = await supabase
        .from("user_upgrade_documents")
        .select("id", { count: "exact", head: true })
        .eq("document_type", "address")
        .eq("status", "pending");

      res.json({
        requests: documents || [],
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: count || 0,
          pages: Math.ceil((count || 0) / parseInt(limit)),
        },
        stats: {
          pending_id: pendingIdDocs?.length || 0,
          pending_address: pendingAddressDocs?.length || 0,
          total_pending:
            (pendingIdDocs?.length || 0) + (pendingAddressDocs?.length || 0),
        },
      });
    } catch (error) {
      console.error("Get upgrade requests error:", error);
      res.status(500).json({ error: "Failed to get upgrade requests" });
    }
  },
);

// Approve upgrade document (admin only)
app.post(
  "/api/admin/upgrade/approve-document/:documentId",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { documentId } = req.params;
      const adminId = req.user.id;

      // Get document
      const { data: document, error: docError } = await supabase
        .from("user_upgrade_documents")
        .select("*, users:user_id(*)")
        .eq("id", documentId)
        .single();

      if (docError || !document) {
        return res.status(404).json({ error: "Document not found" });
      }

      // Update document status
      const { error: updateError } = await supabase
        .from("user_upgrade_documents")
        .update({
          status: "approved",
          reviewed_at: new Date().toISOString(),
          reviewed_by: adminId,
          rejection_reason: null,
        })
        .eq("id", documentId);

      if (updateError) throw updateError;

      // Check if user should be upgraded
      const userId = document.user_id;

      // Get all documents for this user
      const { data: userDocuments } = await supabase
        .from("user_upgrade_documents")
        .select("*")
        .eq("user_id", userId);

      const idDoc = userDocuments?.find((d) => d.document_type === "id");
      const addressDoc = userDocuments?.find(
        (d) => d.document_type === "address",
      );

      let newTier = 1;
      let upgradeMessage = "";

      // Determine new tier based on approved documents
      if (document.document_type === "id" && idDoc?.status === "approved") {
        newTier = 2;
        upgradeMessage =
          "Your ID has been verified. You have been upgraded to Tier 2.";
      }

      if (
        document.document_type === "address" &&
        addressDoc?.status === "approved" &&
        idDoc?.status === "approved"
      ) {
        newTier = 3;
        upgradeMessage =
          "Congratulations! Both your ID and address have been verified. You have been upgraded to Tier 3 (Premium).";
      }

      // Update user tier if needed
      if (newTier > 1) {
        const { data: user, error: userError } = await supabase
          .from("users")
          .select("account_tier")
          .eq("id", userId)
          .single();

        if (!userError && user && newTier > user.account_tier) {
          await supabase
            .from("users")
            .update({
              account_tier: newTier,
              tier_upgraded_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("id", userId);
        }
      }

      // Update upgrade request status
      const { data: upgradeRequest } = await supabase
        .from("user_upgrade_requests")
        .select("*")
        .eq("user_id", userId)
        .single();

      if (upgradeRequest) {
        const idDocStatus = idDoc?.status || "pending";
        const addressDocStatus = addressDoc?.status || "pending";

        let overallStatus = "pending";
        if (idDocStatus === "approved" && addressDocStatus === "approved") {
          overallStatus = "approved";
        } else if (
          idDocStatus === "approved" ||
          addressDocStatus === "approved"
        ) {
          overallStatus = "partially_approved";
        } else if (
          idDocStatus === "rejected" ||
          addressDocStatus === "rejected"
        ) {
          overallStatus = "rejected";
        }

        await supabase
          .from("user_upgrade_requests")
          .update({
            overall_status: overallStatus,
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", userId);
      }

      // Create notification for user
      await supabase.from("notifications").insert({
        user_id: userId,
        title: `Upgrade Document ${document.document_type === "id" ? "ID" : "Address"} Approved`,
        message:
          upgradeMessage ||
          `Your ${document.document_type === "id" ? "ID document" : "address proof"} has been approved.`,
        type: "success",
        created_at: new Date().toISOString(),
      });

      // Log admin action
      await supabase.from("admin_actions").insert({
        admin_id: adminId,
        action_type: "approve_upgrade_document",
        target_user_id: userId,
        details: {
          document_id: documentId,
          document_type: document.document_type,
          new_tier: newTier,
        },
        ip_address: req.ip,
        created_at: new Date().toISOString(),
      });

      res.json({
        success: true,
        message: `Document approved successfully. User upgraded to Tier ${newTier}.`,
        new_tier: newTier,
      });
    } catch (error) {
      console.error("Approve document error:", error);
      res.status(500).json({ error: "Failed to approve document" });
    }
  },
);

// Reject upgrade document (admin only)
app.post(
  "/api/admin/upgrade/reject-document/:documentId",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { documentId } = req.params;
      const { reason } = req.body;
      const adminId = req.user.id;

      if (!reason || reason.trim() === "") {
        return res.status(400).json({ error: "Rejection reason is required" });
      }

      // Get document
      const { data: document, error: docError } = await supabase
        .from("user_upgrade_documents")
        .select("*, users:user_id(*)")
        .eq("id", documentId)
        .single();

      if (docError || !document) {
        return res.status(404).json({ error: "Document not found" });
      }

      // Update document status
      const { error: updateError } = await supabase
        .from("user_upgrade_documents")
        .update({
          status: "rejected",
          reviewed_at: new Date().toISOString(),
          reviewed_by: adminId,
          rejection_reason: reason,
        })
        .eq("id", documentId);

      if (updateError) throw updateError;

      const userId = document.user_id;

      // Update upgrade request status
      const { data: upgradeRequest } = await supabase
        .from("user_upgrade_requests")
        .select("*")
        .eq("user_id", userId)
        .single();

      if (upgradeRequest) {
        await supabase
          .from("user_upgrade_requests")
          .update({
            overall_status: "rejected",
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", userId);
      }

      // Create notification for user
      await supabase.from("notifications").insert({
        user_id: userId,
        title: `Upgrade Document ${document.document_type === "id" ? "ID" : "Address"} Rejected`,
        message: `Your ${document.document_type === "id" ? "ID document" : "address proof"} was rejected. Reason: ${reason}. Please resubmit with correct documents.`,
        type: "error",
        created_at: new Date().toISOString(),
      });

      // Log admin action
      await supabase.from("admin_actions").insert({
        admin_id: adminId,
        action_type: "reject_upgrade_document",
        target_user_id: userId,
        details: {
          document_id: documentId,
          document_type: document.document_type,
          reason: reason,
        },
        ip_address: req.ip,
        created_at: new Date().toISOString(),
      });

      res.json({
        success: true,
        message: "Document rejected successfully",
      });
    } catch (error) {
      console.error("Reject document error:", error);
      res.status(500).json({ error: "Failed to reject document" });
    }
  },
);

// ==================== GET USER ACCOUNT LIMITS BASED ON TIER ====================

app.get(
  "/api/user/account-limits",
  authenticate,
  checkAccountFrozen,
  async (req, res) => {
    try {
      const userId = req.user.id;

      // Get user tier
      const { data: user, error: userError } = await supabase
        .from("users")
        .select("account_tier, is_frozen")
        .eq("id", userId)
        .single();

      if (userError) throw userError;

      // Define tier limits
      const tierLimits = {
        1: {
          max_balance: 500000,
          daily_limit: 150000,
          single_transfer_limit: 150000,
          monthly_limit: 3000000,
          name: "Basic",
        },
        2: {
          max_balance: 800000,
          daily_limit: 250000,
          single_transfer_limit: 250000,
          monthly_limit: 5000000,
          name: "Verified",
        },
        3: {
          max_balance: 999999999,
          daily_limit: 999999999,
          single_transfer_limit: 999999999,
          monthly_limit: 999999999,
          name: "Premium",
        },
      };

      const limits = tierLimits[user.account_tier] || tierLimits[1];

      // Get user's total balance
      const { data: accounts } = await supabase
        .from("accounts")
        .select("balance")
        .eq("user_id", userId);

      const totalBalance =
        accounts?.reduce((sum, acc) => sum + (acc.balance || 0), 0) || 0;

      // Get today's transactions total
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const { data: todayTransactions } = await supabase
        .from("transactions")
        .select("amount")
        .eq("from_user_id", userId)
        .eq("status", "completed")
        .gte("created_at", today.toISOString());

      const dailyUsed =
        todayTransactions?.reduce((sum, t) => sum + (t.amount || 0), 0) || 0;

      // Get this month's transactions total
      const firstDayOfMonth = new Date(
        today.getFullYear(),
        today.getMonth(),
        1,
      );

      const { data: monthTransactions } = await supabase
        .from("transactions")
        .select("amount")
        .eq("from_user_id", userId)
        .eq("status", "completed")
        .gte("created_at", firstDayOfMonth.toISOString());

      const monthlyUsed =
        monthTransactions?.reduce((sum, t) => sum + (t.amount || 0), 0) || 0;

      res.json({
        account_tier: user.account_tier,
        tier_name: limits.name,
        max_balance: limits.max_balance,
        daily_limit: limits.daily_limit,
        single_transfer_limit: limits.single_transfer_limit,
        monthly_limit: limits.monthly_limit,
        daily_used: dailyUsed,
        monthly_used: monthlyUsed,
        total_balance: totalBalance,
        is_frozen: user.is_frozen,
      });
    } catch (error) {
      console.error("Get account limits error:", error);
      res.status(500).json({ error: "Failed to get account limits" });
    }
  },
);

// ==================== GET ACCOUNT TIER INFO ====================

app.get("/api/user/tier-info", authenticate, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: user, error: userError } = await supabase
      .from("users")
      .select("account_tier, is_frozen, freeze_reason, frozen_reason_type")
      .eq("id", userId)
      .single();

    if (userError) throw userError;

    // Get upgrade request status
    const { data: upgradeRequest } = await supabase
      .from("user_upgrade_requests")
      .select("*")
      .eq("user_id", userId)
      .single();

    // Get documents
    const { data: documents } = await supabase
      .from("user_upgrade_documents")
      .select("*")
      .eq("user_id", userId);

    const idDoc = documents?.find((d) => d.document_type === "id");
    const addressDoc = documents?.find((d) => d.document_type === "address");

    const tierLimits = {
      1: { max_balance: 500000, daily_limit: 150000, name: "Basic" },
      2: { max_balance: 800000, daily_limit: 250000, name: "Verified" },
      3: { max_balance: 999999999, daily_limit: 999999999, name: "Premium" },
    };

    // Get total balance to check if exceeds limit
    const { data: accounts } = await supabase
      .from("accounts")
      .select("balance")
      .eq("user_id", userId);

    const totalBalance =
      accounts?.reduce((sum, acc) => sum + (acc.balance || 0), 0) || 0;
    const exceedsBalanceLimit =
      totalBalance > tierLimits[user.account_tier].max_balance;

    res.json({
      current_tier: user.account_tier,
      tier_name: tierLimits[user.account_tier].name,
      max_balance: tierLimits[user.account_tier].max_balance,
      daily_limit: tierLimits[user.account_tier].daily_limit,
      current_balance: totalBalance,
      exceeds_balance_limit: exceedsBalanceLimit,
      is_frozen: user.is_frozen,
      frozen_reason: user.freeze_reason,
      frozen_reason_type: user.frozen_reason_type,
      upgrade_status: {
        email_verified: upgradeRequest?.email_verified || false,
        id_status: idDoc?.status || "not_submitted",
        address_status: addressDoc?.status || "not_submitted",
        id_rejection_reason: idDoc?.rejection_reason,
        address_rejection_reason: addressDoc?.rejection_reason,
        overall_status: upgradeRequest?.overall_status || "none",
      },
    });
  } catch (error) {
    console.error("Get tier info error:", error);
    res.status(500).json({ error: "Failed to get tier information" });
  }
});

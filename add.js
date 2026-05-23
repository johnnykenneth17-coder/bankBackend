// ==================== NEW UPGRADE SYSTEM API ENDPOINTS ====================

// Submit upgrade documents (can submit ID and/or address together)
app.post("/api/user/upgrade/submit-documents", authenticate, async (req, res) => {
    try {
        const { id_document, address_document, id_type, id_number } = req.body;
        
        console.log(`User ${req.user.id} submitting upgrade documents`);
        console.log(`ID Document: ${!!id_document}`);
        console.log(`Address Document: ${!!address_document}`);
        
        // Get current user data
        const { data: user, error: userError } = await supabase
            .from("users")
            .select("account_tier, identification_type, identification_number, address_proof_status, tier_upgrade_status")
            .eq("id", req.user.id)
            .single();
        
        if (userError) throw userError;
        
        // If already Tier 3, cannot submit
        if (user.account_tier >= 3) {
            return res.status(400).json({ error: "Account already at maximum tier" });
        }
        
        const submittedDocs = [];
        let idDocumentId = null;
        let addressDocumentId = null;
        
        // Process ID document submission
        if (id_document && id_type && id_number) {
            // Check if already have ID document pending/approved
            const { data: existingIdDoc } = await supabase
                .from("user_upgrade_documents")
                .select("id, status")
                .eq("user_id", req.user.id)
                .eq("document_type", "id")
                .maybeSingle();
            
            if (existingIdDoc && existingIdDoc.status === "pending") {
                return res.status(400).json({ error: "ID document already pending review" });
            }
            
            if (existingIdDoc && existingIdDoc.status === "approved") {
                return res.status(400).json({ error: "ID already verified. Cannot resubmit." });
            }
            
            // Validate ID number format
            if (!/^\d{11}$/.test(id_number)) {
                return res.status(400).json({ error: "Invalid ID number format. Must be 11 digits." });
            }
            
            // Store ID document
            const { data: idDoc, error: idError } = await supabase
                .from("user_upgrade_documents")
                .upsert({
                    user_id: req.user.id,
                    document_type: "id",
                    document_data: JSON.stringify({
                        image: id_document,
                        id_type: id_type,
                        id_number: id_number,
                        submitted_at: new Date().toISOString()
                    }),
                    status: "pending",
                    submitted_at: new Date().toISOString()
                }, {
                    onConflict: "user_id,document_type",
                    ignoreDuplicates: false
                })
                .select()
                .single();
            
            if (idError) throw idError;
            idDocumentId = idDoc.id;
            submittedDocs.push("id");
            
            // Also update user table with identification info
            await supabase
                .from("users")
                .update({
                    identification_type: id_type,
                    identification_number: id_number,
                    updated_at: new Date().toISOString()
                })
                .eq("id", req.user.id);
        }
        
        // Process address document submission
        if (address_document) {
            // Check if already have address document pending/approved
            const { data: existingAddressDoc } = await supabase
                .from("user_upgrade_documents")
                .select("id, status")
                .eq("user_id", req.user.id)
                .eq("document_type", "address")
                .maybeSingle();
            
            if (existingAddressDoc && existingAddressDoc.status === "pending") {
                return res.status(400).json({ error: "Address document already pending review" });
            }
            
            if (existingAddressDoc && existingAddressDoc.status === "approved") {
                return res.status(400).json({ error: "Address already verified. Cannot resubmit." });
            }
            
            // Store address document
            const { data: addressDoc, error: addressError } = await supabase
                .from("user_upgrade_documents")
                .upsert({
                    user_id: req.user.id,
                    document_type: "address",
                    document_data: JSON.stringify({
                        image: address_document,
                        submitted_at: new Date().toISOString()
                    }),
                    status: "pending",
                    submitted_at: new Date().toISOString()
                }, {
                    onConflict: "user_id,document_type",
                    ignoreDuplicates: false
                })
                .select()
                .single();
            
            if (addressError) throw addressError;
            addressDocumentId = addressDoc.id;
            submittedDocs.push("address");
            
            // Update user's address proof status
            await supabase
                .from("users")
                .update({
                    address_proof_status: "pending",
                    address_proof_image: address_document,
                    updated_at: new Date().toISOString()
                })
                .eq("id", req.user.id);
        }
        
        // Determine overall status
        let overallStatus = "none";
        if (submittedDocs.length === 2) {
            overallStatus = "both_pending";
        } else if (submittedDocs[0] === "id") {
            overallStatus = "id_pending";
        } else if (submittedDocs[0] === "address") {
            overallStatus = "address_pending";
        }
        
        // Create or update upgrade request
        const { error: requestError } = await supabase
            .from("user_upgrade_requests")
            .upsert({
                user_id: req.user.id,
                id_document_id: idDocumentId,
                address_document_id: addressDocumentId,
                overall_status: overallStatus,
                current_tier_requested: address_document ? 3 : 2,
                updated_at: new Date().toISOString()
            }, {
                onConflict: "user_id",
                ignoreDuplicates: false
            });
        
        if (requestError) throw requestError;
        
        // Update user's upgrade status
        await supabase
            .from("users")
            .update({
                tier_upgrade_status: "pending",
                tier_upgrade_requested_at: new Date().toISOString()
            })
            .eq("id", req.user.id);
        
        // Send notification to admins
        const { data: admins } = await supabase
            .from("users")
            .select("id")
            .eq("role", "admin");
        
        for (const admin of admins || []) {
            await supabase.from("notifications").insert({
                user_id: admin.id,
                title: "New Upgrade Documents Submitted",
                message: `User ${req.user.email} has submitted ${submittedDocs.join(" and ")} document(s) for verification.`,
                type: "info",
                created_at: new Date().toISOString()
            });
        }
        
        // Create notification for user
        await supabase.from("notifications").insert({
            user_id: req.user.id,
            title: "Documents Submitted for Review",
            message: `Your ${submittedDocs.join(" and ")} document(s) have been submitted successfully. You will be notified once reviewed.`,
            type: "info",
            created_at: new Date().toISOString()
        });
        
        res.json({
            success: true,
            message: "Documents submitted for review",
            submitted_documents: submittedDocs,
            overall_status: overallStatus
        });
        
    } catch (error) {
        console.error("Submit documents error:", error);
        res.status(500).json({ error: "Failed to submit documents: " + error.message });
    }
});

// Get user upgrade status (for dashboard)
app.get("/api/user/upgrade/status", authenticate, async (req, res) => {
    try {
        // Get user info
        const { data: user, error: userError } = await supabase
            .from("users")
            .select("account_tier, tier_upgrade_status, address_proof_status, identification_type, identification_number")
            .eq("id", req.user.id)
            .single();
        
        if (userError) throw userError;
        
        // Get upgrade documents status
        const { data: documents } = await supabase
            .from("user_upgrade_documents")
            .select("*")
            .eq("user_id", req.user.id);
        
        const idDoc = documents?.find(d => d.document_type === "id");
        const addressDoc = documents?.find(d => d.document_type === "address");
        
        // Get upgrade request
        const { data: upgradeRequest } = await supabase
            .from("user_upgrade_requests")
            .select("*")
            .eq("user_id", req.user.id)
            .maybeSingle();
        
        // Determine status for frontend
        let upgradeStatus = {
            can_upgrade: true,
            current_tier: user.account_tier,
            id_status: idDoc?.status || "none",
            address_status: addressDoc?.status || "none",
            overall_status: upgradeRequest?.overall_status || "none",
            id_rejection_reason: idDoc?.rejection_reason,
            address_rejection_reason: addressDoc?.rejection_reason
        };
        
        // Check if user is already Tier 3
        if (user.account_tier >= 3) {
            upgradeStatus.can_upgrade = false;
            upgradeStatus.message = "You are already at the highest tier";
        }
        
        // Check if both documents pending
        if (idDoc?.status === "pending" && addressDoc?.status === "pending") {
            upgradeStatus.message = "Both documents under review";
        } else if (idDoc?.status === "pending") {
            upgradeStatus.message = "ID document under review";
        } else if (addressDoc?.status === "pending") {
            upgradeStatus.message = "Address proof under review";
        }
        
        res.json(upgradeStatus);
        
    } catch (error) {
        console.error("Get upgrade status error:", error);
        res.status(500).json({ error: "Failed to get upgrade status" });
    }
});

// ==================== NEW ADMIN UPGRADE ENDPOINTS ====================

// Get all upgrade requests (admin)
app.get("/api/admin/upgrade-requests", authenticate, authorizeAdmin, async (req, res) => {
    try {
        const { page = 1, limit = 20, search, status, document_type } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);
        
        // Build query for upgrade documents with user info
        let query = supabase
            .from("user_upgrade_documents")
            .select(`
                *,
                users!inner (
                    id,
                    first_name,
                    last_name,
                    email,
                    phone,
                    account_tier
                )
            `, { count: "exact" });
        
        // Apply filters
        if (status && status !== "all") {
            query = query.eq("status", status);
        } else {
            query = query.eq("status", "pending");
        }
        
        if (document_type && document_type !== "all") {
            query = query.eq("document_type", document_type);
        }
        
        if (search) {
            query = query.or(`users.first_name.ilike.%${search}%,users.last_name.ilike.%${search}%,users.email.ilike.%${search}%`);
        }
        
        const { data: documents, error, count } = await query
            .order("submitted_at", { ascending: false })
            .range(offset, offset + parseInt(limit) - 1);
        
        if (error) throw error;
        
        // Format response
        const formattedRequests = (documents || []).map(doc => ({
            id: doc.id,
            user_id: doc.user_id,
            user_name: `${doc.users?.first_name || ""} ${doc.users?.last_name || ""}`.trim(),
            user_email: doc.users?.email,
            document_type: doc.document_type,
            document_data: typeof doc.document_data === "string" ? JSON.parse(doc.document_data) : doc.document_data,
            status: doc.status,
            submitted_at: doc.submitted_at,
            current_user_tier: doc.users?.account_tier
        }));
        
        // Get stats for dashboard
        const { count: pendingIdCount } = await supabase
            .from("user_upgrade_documents")
            .select("*", { count: "exact", head: true })
            .eq("document_type", "id")
            .eq("status", "pending");
        
        const { count: pendingAddressCount } = await supabase
            .from("user_upgrade_documents")
            .select("*", { count: "exact", head: true })
            .eq("document_type", "address")
            .eq("status", "pending");
        
        res.json({
            requests: formattedRequests,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: count || 0,
                pages: Math.ceil((count || 0) / parseInt(limit))
            },
            stats: {
                pending_id: pendingIdCount || 0,
                pending_address: pendingAddressCount || 0,
                total_pending: (pendingIdCount || 0) + (pendingAddressCount || 0)
            }
        });
        
    } catch (error) {
        console.error("Get upgrade requests error:", error);
        res.status(500).json({ error: "Failed to load upgrade requests" });
    }
});

// Admin approve specific document
app.post("/api/admin/upgrade/approve-document/:documentId", authenticate, authorizeAdmin, async (req, res) => {
    try {
        const { documentId } = req.params;
        
        // Get document with user info
        const { data: document, error: docError } = await supabase
            .from("user_upgrade_documents")
            .select(`
                *,
                users!inner (
                    id,
                    first_name,
                    last_name,
                    email,
                    account_tier,
                    identification_type,
                    identification_number
                )
            `)
            .eq("id", documentId)
            .single();
        
        if (docError || !document) {
            return res.status(404).json({ error: "Document not found" });
        }
        
        if (document.status !== "pending") {
            return res.status(400).json({ error: "Document already processed" });
        }
        
        // Update document status
        const { error: updateError } = await supabase
            .from("user_upgrade_documents")
            .update({
                status: "approved",
                reviewed_at: new Date().toISOString(),
                reviewed_by: req.user.id
            })
            .eq("id", documentId);
        
        if (updateError) throw updateError;
        
        const userId = document.user_id;
        const currentTier = document.users?.account_tier || 1;
        let newTier = currentTier;
        
        // Check if ID document approved
        if (document.document_type === "id") {
            // If user is Tier 1, upgrade to Tier 2
            if (currentTier < 2) {
                newTier = 2;
                
                await supabase
                    .from("users")
                    .update({
                        account_tier: 2,
                        tier_upgrade_status: "approved",
                        updated_at: new Date().toISOString()
                    })
                    .eq("id", userId);
            }
            
            // Check if address document also approved for this user
            const { data: addressDoc } = await supabase
                .from("user_upgrade_documents")
                .select("status")
                .eq("user_id", userId)
                .eq("document_type", "address")
                .eq("status", "approved")
                .maybeSingle();
            
            // If both documents approved and user not yet Tier 3, upgrade to Tier 3
            if (addressDoc && currentTier < 3) {
                newTier = 3;
                await supabase
                    .from("users")
                    .update({
                        account_tier: 3,
                        address_proof_status: "verified",
                        updated_at: new Date().toISOString()
                    })
                    .eq("id", userId);
            }
        }
        
        // If address document approved, check if ID is also approved
        if (document.document_type === "address") {
            await supabase
                .from("users")
                .update({
                    address_proof_status: "verified",
                    updated_at: new Date().toISOString()
                })
                .eq("id", userId);
            
            // Check if ID document is approved and user not yet Tier 3
            const { data: idDoc } = await supabase
                .from("user_upgrade_documents")
                .select("status")
                .eq("user_id", userId)
                .eq("document_type", "id")
                .eq("status", "approved")
                .maybeSingle();
            
            if (idDoc && currentTier < 3) {
                newTier = 3;
                await supabase
                    .from("users")
                    .update({
                        account_tier: 3,
                        updated_at: new Date().toISOString()
                    })
                    .eq("id", userId);
            }
        }
        
        // Update overall upgrade request status
        const { data: idDocStatus } = await supabase
            .from("user_upgrade_documents")
            .select("status")
            .eq("user_id", userId)
            .eq("document_type", "id")
            .maybeSingle();
        
        const { data: addressDocStatus } = await supabase
            .from("user_upgrade_documents")
            .select("status")
            .eq("user_id", userId)
            .eq("document_type", "address")
            .maybeSingle();
        
        let overallStatus = "none";
        if (idDocStatus?.status === "approved" && addressDocStatus?.status === "approved") {
            overallStatus = "both_approved";
        } else if (idDocStatus?.status === "approved") {
            overallStatus = "id_approved";
        } else if (addressDocStatus?.status === "approved") {
            overallStatus = "address_approved";
        } else if (idDocStatus?.status === "pending" || addressDocStatus?.status === "pending") {
            overallStatus = "pending";
        }
        
        await supabase
            .from("user_upgrade_requests")
            .update({
                overall_status: overallStatus,
                updated_at: new Date().toISOString()
            })
            .eq("user_id", userId);
        
        // Create notification for user
        const documentTypeName = document.document_type === "id" ? "ID document" : "Address proof";
        const tierUpgradeMessage = newTier > currentTier ? ` Your account has been upgraded to Tier ${newTier}!` : "";
        
        await supabase.from("notifications").insert({
            user_id: userId,
            title: `✅ ${documentTypeName} Approved`,
            message: `Your ${documentTypeName} has been approved.${tierUpgradeMessage}`,
            type: "success",
            created_at: new Date().toISOString()
        });
        
        // Log admin action
        await supabase.from("admin_actions").insert({
            admin_id: req.user.id,
            action_type: "approve_upgrade_document",
            target_user_id: userId,
            details: {
                document_type: document.document_type,
                new_tier: newTier,
                previous_tier: currentTier
            },
            created_at: new Date().toISOString()
        });
        
        res.json({
            success: true,
            message: `Document approved. User tier: ${newTier}`,
            new_tier: newTier
        });
        
    } catch (error) {
        console.error("Approve document error:", error);
        res.status(500).json({ error: "Failed to approve document" });
    }
});

// Admin reject specific document
app.post("/api/admin/upgrade/reject-document/:documentId", authenticate, authorizeAdmin, async (req, res) => {
    try {
        const { documentId } = req.params;
        const { reason } = req.body;
        
        if (!reason) {
            return res.status(400).json({ error: "Rejection reason required" });
        }
        
        // Get document with user info
        const { data: document, error: docError } = await supabase
            .from("user_upgrade_documents")
            .select(`
                *,
                users!inner (
                    id,
                    first_name,
                    last_name,
                    email
                )
            `)
            .eq("id", documentId)
            .single();
        
        if (docError || !document) {
            return res.status(404).json({ error: "Document not found" });
        }
        
        if (document.status !== "pending") {
            return res.status(400).json({ error: "Document already processed" });
        }
        
        // Update document status
        const { error: updateError } = await supabase
            .from("user_upgrade_documents")
            .update({
                status: "rejected",
                rejection_reason: reason,
                reviewed_at: new Date().toISOString(),
                reviewed_by: req.user.id
            })
            .eq("id", documentId);
        
        if (updateError) throw updateError;
        
        const userId = document.user_id;
        
        // Create rejection notification for user
        const documentTypeName = document.document_type === "id" ? "ID document" : "Address proof";
        
        await supabase.from("notifications").insert({
            user_id: userId,
            title: `❌ ${documentTypeName} Rejected`,
            message: `Your ${documentTypeName} was rejected. Reason: ${reason}. Please submit a valid document.`,
            type: "error",
            created_at: new Date().toISOString()
        });
        
        // Update user's upgrade status if needed
        await supabase
            .from("users")
            .update({
                tier_upgrade_status: "rejected",
                updated_at: new Date().toISOString()
            })
            .eq("id", userId);
        
        // Log admin action
        await supabase.from("admin_actions").insert({
            admin_id: req.user.id,
            action_type: "reject_upgrade_document",
            target_user_id: userId,
            details: {
                document_type: document.document_type,
                reason: reason
            },
            created_at: new Date().toISOString()
        });
        
        res.json({
            success: true,
            message: "Document rejected"
        });
        
    } catch (error) {
        console.error("Reject document error:", error);
        res.status(500).json({ error: "Failed to reject document" });
    }
});
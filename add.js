// ==================== UPGRADE SYSTEM DATABASE SETUP ====================
// Run this SQL in your Supabase SQL editor first:
/*
-- Create upgrade tables (run this in Supabase SQL editor)
CREATE TABLE IF NOT EXISTS user_upgrade_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    document_type VARCHAR(20) NOT NULL,
    document_data TEXT NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    rejection_reason TEXT,
    submitted_at TIMESTAMP DEFAULT NOW(),
    reviewed_at TIMESTAMP,
    reviewed_by UUID REFERENCES users(id),
    UNIQUE(user_id, document_type)
);

CREATE TABLE IF NOT EXISTS user_upgrade_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
    id_document_id UUID REFERENCES user_upgrade_documents(id),
    address_document_id UUID REFERENCES user_upgrade_documents(id),
    overall_status VARCHAR(20) DEFAULT 'none',
    current_tier_requested INTEGER DEFAULT 2,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_upgrade_documents_user ON user_upgrade_documents(user_id);
CREATE INDEX IF NOT EXISTS idx_upgrade_documents_status ON user_upgrade_documents(status);
CREATE INDEX IF NOT EXISTS idx_upgrade_requests_user ON user_upgrade_requests(user_id);
*/

// ==================== UPGRADE SYSTEM API ENDPOINTS ====================

// Get user upgrade status
app.get("/api/user/upgrade/status", authenticate, async (req, res) => {
    try {
        const { data: user, error: userError } = await supabase
            .from("users")
            .select("account_tier")
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
        
        res.json({
            current_tier: user.account_tier,
            id_status: idDoc?.status || "none",
            address_status: addressDoc?.status || "none",
            id_rejection_reason: idDoc?.rejection_reason,
            address_rejection_reason: addressDoc?.rejection_reason
        });
        
    } catch (error) {
        console.error("Get upgrade status error:", error);
        res.status(500).json({ error: "Failed to get upgrade status" });
    }
});

// Submit upgrade documents
app.post("/api/user/upgrade/submit-documents", authenticate, async (req, res) => {
    try {
        const { id_document, address_document, id_type, id_number } = req.body;
        
        console.log(`User ${req.user.id} submitting documents - ID: ${!!id_document}, Address: ${!!address_document}`);
        
        // Get current user data
        const { data: user, error: userError } = await supabase
            .from("users")
            .select("account_tier")
            .eq("id", req.user.id)
            .single();
        
        if (userError) throw userError;
        
        if (user.account_tier >= 3) {
            return res.status(400).json({ error: "Account already at maximum tier" });
        }
        
        const submittedDocs = [];
        
        // Process ID document
        if (id_document && id_type && id_number) {
            // Validate ID number
            if (!/^\d{11}$/.test(id_number)) {
                return res.status(400).json({ error: "Invalid ID number format. Must be 11 digits." });
            }
            
            // Check existing
            const { data: existingId } = await supabase
                .from("user_upgrade_documents")
                .select("status")
                .eq("user_id", req.user.id)
                .eq("document_type", "id")
                .maybeSingle();
            
            if (existingId && existingId.status === "pending") {
                return res.status(400).json({ error: "ID document already pending review" });
            }
            
            // Upsert ID document
            const { error: idError } = await supabase
                .from("user_upgrade_documents")
                .upsert({
                    user_id: req.user.id,
                    document_type: "id",
                    document_data: JSON.stringify({
                        image: id_document,
                        id_type: id_type,
                        id_number: id_number
                    }),
                    status: "pending",
                    submitted_at: new Date().toISOString()
                }, {
                    onConflict: "user_id,document_type"
                });
            
            if (idError) throw idError;
            submittedDocs.push("ID");
            
            // Update user table
            await supabase
                .from("users")
                .update({
                    identification_type: id_type,
                    identification_number: id_number,
                    tier_upgrade_status: "pending",
                    tier_upgrade_requested_at: new Date().toISOString()
                })
                .eq("id", req.user.id);
        }
        
        // Process address document
        if (address_document) {
            // Check existing
            const { data: existingAddress } = await supabase
                .from("user_upgrade_documents")
                .select("status")
                .eq("user_id", req.user.id)
                .eq("document_type", "address")
                .maybeSingle();
            
            if (existingAddress && existingAddress.status === "pending") {
                return res.status(400).json({ error: "Address document already pending review" });
            }
            
            // Upsert address document
            const { error: addressError } = await supabase
                .from("user_upgrade_documents")
                .upsert({
                    user_id: req.user.id,
                    document_type: "address",
                    document_data: JSON.stringify({
                        image: address_document
                    }),
                    status: "pending",
                    submitted_at: new Date().toISOString()
                }, {
                    onConflict: "user_id,document_type"
                });
            
            if (addressError) throw addressError;
            submittedDocs.push("Address");
            
            // Update user table
            await supabase
                .from("users")
                .update({
                    address_proof_status: "pending",
                    address_proof_image: address_document
                })
                .eq("id", req.user.id);
        }
        
        // Send notification to admins
        const { data: admins } = await supabase
            .from("users")
            .select("id")
            .eq("role", "admin");
        
        for (const admin of admins || []) {
            await supabase.from("notifications").insert({
                user_id: admin.id,
                title: "New Upgrade Documents",
                message: `User ${req.user.email} submitted ${submittedDocs.join(" and ")} document(s) for verification.`,
                type: "info",
                created_at: new Date().toISOString()
            });
        }
        
        // Notify user
        await supabase.from("notifications").insert({
            user_id: req.user.id,
            title: "Documents Submitted",
            message: `Your ${submittedDocs.join(" and ")} document(s) have been submitted. You'll be notified once reviewed.`,
            type: "success",
            created_at: new Date().toISOString()
        });
        
        res.json({
            success: true,
            message: `Your ${submittedDocs.join(" and ")} document(s) have been submitted for review.`
        });
        
    } catch (error) {
        console.error("Submit documents error:", error);
        res.status(500).json({ error: "Failed to submit documents: " + error.message });
    }
});

// Admin: Get upgrade requests
app.get("/api/admin/upgrade-requests", authenticate, authorizeAdmin, async (req, res) => {
    try {
        const { page = 1, limit = 20, status = "pending", document_type = "all", search = "" } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);
        
        let query = supabase
            .from("user_upgrade_documents")
            .select(`
                *,
                users!inner (
                    id,
                    first_name,
                    last_name,
                    email,
                    account_tier
                )
            `, { count: "exact" });
        
        if (status !== "all") {
            query = query.eq("status", status);
        } else {
            query = query.eq("status", "pending");
        }
        
        if (document_type !== "all") {
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
            current_user_tier: doc.users?.account_tier,
            reviewed_at: doc.reviewed_at,
            rejection_reason: doc.rejection_reason
        }));
        
        // Get counts for stats
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
        res.status(500).json({ error: "Failed to load upgrade requests: " + error.message });
    }
});

// Admin: Approve document
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
                    account_tier
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
        
        const userId = document.user_id;
        const currentTier = document.users?.account_tier || 1;
        
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
        
        let newTier = currentTier;
        
        // Check if ID document was approved
        if (document.document_type === "id") {
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
            
            // Check if address document also approved
            const { data: addressDoc } = await supabase
                .from("user_upgrade_documents")
                .select("status")
                .eq("user_id", userId)
                .eq("document_type", "address")
                .eq("status", "approved")
                .maybeSingle();
            
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
        
        // If address document approved, check if ID also approved
        if (document.document_type === "address") {
            await supabase
                .from("users")
                .update({
                    address_proof_status: "verified",
                    updated_at: new Date().toISOString()
                })
                .eq("id", userId);
            
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
        
        // Create notification
        const docTypeName = document.document_type === "id" ? "ID document" : "Address proof";
        await supabase.from("notifications").insert({
            user_id: userId,
            title: "Document Approved ✅",
            message: `Your ${docTypeName} has been approved.${newTier > currentTier ? ` Your account has been upgraded to Tier ${newTier}!` : ""}`,
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
            message: `Document approved. User is now Tier ${newTier}`,
            new_tier: newTier
        });
        
    } catch (error) {
        console.error("Approve document error:", error);
        res.status(500).json({ error: "Failed to approve document: " + error.message });
    }
});

// Admin: Reject document
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
        
        // Update user's upgrade status
        await supabase
            .from("users")
            .update({
                tier_upgrade_status: "rejected"
            })
            .eq("id", document.user_id);
        
        // Create notification
        const docTypeName = document.document_type === "id" ? "ID document" : "Address proof";
        await supabase.from("notifications").insert({
            user_id: document.user_id,
            title: "Document Rejected ❌",
            message: `Your ${docTypeName} was rejected. Reason: ${reason}. Please submit a valid document.`,
            type: "error",
            created_at: new Date().toISOString()
        });
        
        // Log admin action
        await supabase.from("admin_actions").insert({
            admin_id: req.user.id,
            action_type: "reject_upgrade_document",
            target_user_id: document.user_id,
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
        res.status(500).json({ error: "Failed to reject document: " + error.message });
    }
});
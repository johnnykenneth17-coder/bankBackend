




// Admin: Get upgrade requests - FIXED with proper joins
app.get("/api/admin/upgrade-requests", authenticate, authorizeAdmin, async (req, res) => {
    try {
        const { page = 1, limit = 20, status = "pending", document_type = "all", search = "" } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);
        
        // Build query - use explicit table names to avoid ambiguity
        let query = supabase
            .from("user_upgrade_documents")
            .select(`
                id,
                user_id,
                document_type,
                document_data,
                status,
                rejection_reason,
                submitted_at,
                reviewed_at,
                users!user_upgrade_documents_user_id_fkey (
                    id,
                    first_name,
                    last_name,
                    email,
                    account_tier
                )
            `);
        
        // Apply filters
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
            .order("submitted_at", { ascending: false });
        
        if (error) {
            console.error("Query error:", error);
            throw error;
        }
        
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
        
        // Apply pagination manually
        const paginatedRequests = formattedRequests.slice(offset, offset + parseInt(limit));
        
        // Get counts for stats - using separate queries
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
            requests: paginatedRequests,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: formattedRequests.length,
                pages: Math.ceil(formattedRequests.length / parseInt(limit))
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

// Admin: Approve document - FIXED
app.post("/api/admin/upgrade/approve-document/:documentId", authenticate, authorizeAdmin, async (req, res) => {
    try {
        const { documentId } = req.params;
        
        // Get document with user info - use explicit join
        const { data: document, error: docError } = await supabase
            .from("user_upgrade_documents")
            .select(`
                id,
                user_id,
                document_type,
                document_data,
                status,
                users!user_upgrade_documents_user_id_fkey (
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
            
            // Check if address document also approved for this user
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

// Admin: Reject document - FIXED
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
                id,
                user_id,
                document_type,
                users!user_upgrade_documents_user_id_fkey (
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
                tier_upgrade_status: "rejected",
                updated_at: new Date().toISOString()
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
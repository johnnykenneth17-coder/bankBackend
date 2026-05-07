// ==================== ADMIN LOGS ROUTES ====================

// Get admin action logs with pagination and filters
app.get(
  "/api/admin/logs",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { 
        page = 1, 
        limit = 50, 
        action_type, 
        target_user_id,
        start_date,
        end_date,
        search 
      } = req.query;
      
      const offset = (parseInt(page) - 1) * parseInt(limit);

      let query = supabase
        .from("admin_actions")
        .select(`
          *,
          admin:admin_id (id, email, first_name, last_name),
          target_user:target_user_id (id, email, first_name, last_name)
        `, { count: "exact" })
        .order("created_at", { ascending: false });

      // Apply filters
      if (action_type && action_type !== "all") {
        query = query.eq("action_type", action_type);
      }

      if (target_user_id) {
        query = query.eq("target_user_id", target_user_id);
      }

      if (start_date) {
        query = query.gte("created_at", start_date);
      }

      if (end_date) {
        query = query.lte("created_at", `${end_date}T23:59:59`);
      }

      if (search) {
        query = query.or(`action_type.ilike.%${search}%,details::text.ilike.%${search}%`);
      }

      const { data: logs, error, count } = await query
        .range(offset, offset + parseInt(limit) - 1);

      if (error) throw error;

      // Get unique action types for filter dropdown
      const { data: actionTypes } = await supabase
        .from("admin_actions")
        .select("action_type")
        .limit(100);

      const uniqueActionTypes = [...new Set((actionTypes || []).map(a => a.action_type))];

      res.json({
        logs: logs || [],
        action_types: uniqueActionTypes,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: count || 0,
          pages: Math.ceil((count || 0) / parseInt(limit))
        }
      });
    } catch (error) {
      console.error("Admin logs fetch error:", error);
      res.status(500).json({ error: "Failed to fetch admin logs" });
    }
  }
);

// Get single log details
app.get(
  "/api/admin/logs/:logId",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { logId } = req.params;

      const { data: log, error } = await supabase
        .from("admin_actions")
        .select(`
          *,
          admin:admin_id (id, email, first_name, last_name),
          target_user:target_user_id (id, email, first_name, last_name)
        `)
        .eq("id", logId)
        .single();

      if (error) throw error;

      res.json(log);
    } catch (error) {
      console.error("Admin log fetch error:", error);
      res.status(500).json({ error: "Failed to fetch log details" });
    }
  }
);

// ==================== FIXED SUPPORT TICKET MESSAGES ROUTE ====================

// Get messages for a support ticket (admin) - FIXED
app.get(
  "/api/admin/support-tickets/:ticketId/messages",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { ticketId } = req.params;

      // First verify ticket exists
      const { data: ticket, error: ticketError } = await supabase
        .from("support_tickets")
        .select("id, user_id, status")
        .eq("id", ticketId)
        .single();

      if (ticketError || !ticket) {
        return res.status(404).json({ error: "Ticket not found" });
      }

      // Get messages with sender info
      const { data: messages, error } = await supabase
        .from("chat_messages")
        .select(`
          *,
          sender:sender_id (id, first_name, last_name, email, role)
        `)
        .eq("ticket_id", ticketId)
        .order("created_at", { ascending: true });

      if (error) {
        console.error("Messages fetch error:", error);
        return res.status(500).json({ error: "Failed to fetch messages" });
      }

      // Also get user info for the ticket
      const { data: user } = await supabase
        .from("users")
        .select("first_name, last_name, email")
        .eq("id", ticket.user_id)
        .single();

      res.json({
        messages: messages || [],
        ticket: {
          id: ticket.id,
          status: ticket.status,
          user: user
        }
      });
    } catch (error) {
      console.error("Support ticket messages error:", error);
      res.status(500).json({ error: "Failed to fetch ticket messages" });
    }
  }
);
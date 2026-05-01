// api/savings.js - Separate API file for savings routes
const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const { authenticate } = require("./auth"); // Adjust path as needed

const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

// GET savings status - check active plans
router.get("/status", authenticate, async (req, res) => {
  try {
    console.log("Fetching savings status for user:", req.user.id);

    const [fixed, savebox, target, spareChange] = await Promise.all([
      supabase
        .from("fixed_savings")
        .select("id, status, auto_save, current_saved, maturity_date")
        .eq("user_id", req.user.id)
        .in("status", ["active", "matured"])
        .maybeSingle(),
      supabase
        .from("savebox_savings")
        .select("id, status, auto_save, current_saved, target_date")
        .eq("user_id", req.user.id)
        .eq("status", "active")
        .maybeSingle(),
      supabase
        .from("target_savings")
        .select(
          "id, status, auto_save, current_saved, target_amount, withdrawal_date",
        )
        .eq("user_id", req.user.id)
        .eq("status", "active")
        .maybeSingle(),
      supabase
        .from("spare_change_savings")
        .select("id, status, auto_save, current_saved")
        .eq("user_id", req.user.id)
        .eq("status", "active")
        .maybeSingle(),
    ]);

    const totalSaved =
      (fixed.data?.current_saved || 0) +
      (savebox.data?.current_saved || 0) +
      (target.data?.current_saved || 0) +
      (spareChange.data?.current_saved || 0);

    res.json({
      success: true,
      total_saved: totalSaved,
      has_active_fixed: !!fixed.data,
      has_active_savebox: !!savebox.data,
      has_active_target: !!target.data,
      has_active_spare_change: !!spareChange.data,
      active_plans: {
        fixed: fixed.data || null,
        savebox: savebox.data || null,
        target: target.data || null,
        spare_change: spareChange.data || null,
      },
    });
  } catch (error) {
    console.error("Savings status error:", error);
    res
      .status(500)
      .json({ error: "Failed to get savings status: " + error.message });
  }
});

// GET all savings for user
router.get("/", authenticate, async (req, res) => {
  try {
    // Your existing savings fetch logic here
    // ... similar to your current /api/user/savings endpoint
    res.json({ savings: [] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST start a savings plan
router.post("/start", authenticate, async (req, res) => {
  try {
    // Your existing start savings logic here
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;

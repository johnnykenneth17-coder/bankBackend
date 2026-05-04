// api/savings.js - Complete savings API routes
const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

// Authentication middleware for savings routes
async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);

    if (error || !user) {
      // Fallback to JWT verification if Supabase auth fails
      const jwt = require("jsonwebtoken");
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const { data: dbUser } = await supabase
        .from("users")
        .select("*")
        .eq("id", decoded.userId)
        .single();

      if (!dbUser) throw new Error("User not found");
      req.user = dbUser;
      return next();
    }

    req.user = user;
    next();
  } catch (error) {
    console.error("Auth error:", error);
    res.status(401).json({ error: "Invalid token" });
  }
}

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

// GET single savings details by type and id
router.get("/:type/:id", authenticate, async (req, res) => {
  const { type, id } = req.params;

  try {
    console.log(`Fetching ${type} savings ${id} for user:`, req.user.id);

    let result = null;
    const today = new Date();

    switch (type) {
      case "harvest":
        const { data: harvest, error: hError } = await supabase
          .from("user_harvest_enrollments")
          .select(
            "*, harvest_plans(name, daily_amount, duration_days, reward_items)",
          )
          .eq("id", id)
          .eq("user_id", req.user.id)
          .single();
        if (hError) throw hError;
        result = {
          ...harvest,
          type: "harvest",
          plan_name: harvest.harvest_plans?.name,
          total_days: harvest.harvest_plans?.duration_days,
          reward_items: harvest.harvest_plans?.reward_items,
        };
        break;

      case "fixed":
        const { data: fixed, error: fError } = await supabase
          .from("fixed_savings")
          .select("*")
          .eq("id", id)
          .eq("user_id", req.user.id)
          .single();
        if (fError) throw fError;

        const maturityDate = new Date(fixed.maturity_date);
        const daysUntilMaturity = Math.max(
          0,
          Math.ceil((maturityDate - today) / (1000 * 60 * 60 * 24)),
        );
        const isMatured = maturityDate <= today;
        const freeWithdrawalDate = new Date(fixed.next_free_withdrawal_date);
        const isFreeWithdrawal = isMatured && today <= freeWithdrawalDate;
        const interestEarned =
          (fixed.current_saved || 0) * (fixed.interest_rate / 100);

        result = {
          ...fixed,
          type: "fixed",
          days_until_maturity: daysUntilMaturity,
          status: isMatured ? "matured" : fixed.status,
          is_free_withdrawal_available: isFreeWithdrawal,
          interest_earned: interestEarned,
          total_with_interest: (fixed.current_saved || 0) + interestEarned,
        };
        break;

      case "savebox":
        const { data: savebox, error: sError } = await supabase
          .from("savebox_savings")
          .select("*")
          .eq("id", id)
          .eq("user_id", req.user.id)
          .single();
        if (sError) throw sError;
        result = { ...savebox, type: "savebox" };
        break;

      case "target":
        const { data: target, error: tError } = await supabase
          .from("target_savings")
          .select("*")
          .eq("id", id)
          .eq("user_id", req.user.id)
          .single();
        if (tError) throw tError;

        const withdrawalDate = new Date(target.withdrawal_date);
        const daysUntilWithdrawal = Math.max(
          0,
          Math.ceil((withdrawalDate - today) / (1000 * 60 * 60 * 24)),
        );
        const percentComplete =
          target.target_amount > 0
            ? (target.current_saved / target.target_amount) * 100
            : 0;
        const canWithdraw =
          withdrawalDate <= today &&
          target.current_saved >= target.target_amount;

        result = {
          ...target,
          type: "target",
          days_until_withdrawal: daysUntilWithdrawal,
          percent_complete: percentComplete,
          can_withdraw: canWithdraw,
          status: canWithdraw ? "completed" : target.status,
        };
        break;

      case "spare_change":
        const { data: spare, error: spError } = await supabase
          .from("spare_change_savings")
          .select("*")
          .eq("id", id)
          .eq("user_id", req.user.id)
          .single();
        if (spError) throw spError;
        result = { ...spare, type: "spare_change" };
        break;

      default:
        return res.status(400).json({ error: "Invalid savings type" });
    }

    res.json(result);
  } catch (error) {
    console.error("Get savings detail error:", error);
    res
      .status(500)
      .json({ error: "Failed to fetch savings details: " + error.message });
  }
});

// GET summary of all savings
router.get("/summary", authenticate, async (req, res) => {
  try {
    const [harvest, fixed, savebox, target, spareChange] = await Promise.all([
      supabase
        .from("user_harvest_enrollments")
        .select("id, status, auto_save, total_saved")
        .eq("user_id", req.user.id)
        .eq("status", "active")
        .maybeSingle(),
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
      (harvest.data?.total_saved || 0) +
      (fixed.data?.current_saved || 0) +
      (savebox.data?.current_saved || 0) +
      (target.data?.current_saved || 0) +
      (spareChange.data?.current_saved || 0);

    res.json({
      total_saved: totalSaved,
      active_plans: {
        harvest: harvest.data || null,
        fixed: fixed.data || null,
        savebox: savebox.data || null,
        target: target.data || null,
        spare_change: spareChange.data || null,
      },
    });
  } catch (error) {
    res
      .status(500)
      .json({ error: "Failed to get savings summary: " + error.message });
  }
});

module.exports = router;

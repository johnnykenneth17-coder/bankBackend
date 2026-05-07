/*case "target":
  const { data: existingTarget, error: eTarget } = await supabase
    .from("target_savings")
    .select("id, status")
    .eq("user_id", req.user.id)
    .eq("status", "active");
  if (existingTarget && existingTarget.length > 0) {
    return res.status(400).json({
      error: "You already have an active Target Savings plan. Complete it before starting a new one.",
      existing_plan: existingTarget[0],
    });
  }
  break;*/
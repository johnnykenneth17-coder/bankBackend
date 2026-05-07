async function processHarvestPlans() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  console.log(`[${new Date().toISOString()}] Processing Harvest Plans...`);

  // IMPORTANT: Use a simpler query first to debug
  const { data: enrollments, error } = await supabase
    .from("user_harvest_enrollments")
    .select(`
      *,
      users!inner(id, email, first_name, last_name, is_frozen),
      harvest_plans!inner(daily_amount, duration_days, name, reward_items)
    `)
    .eq("status", "active")
    .eq("auto_save", true);

  if (error) {
    console.error("Harvest plans fetch error:", error);
    return;
  }

  // Filter for those that need deduction (next_deduction_due is null OR in the past)
  const now = new Date().toISOString();
  const needDeduction = (enrollments || []).filter(e => {
    if (!e.next_deduction_due) return true;
    return new Date(e.next_deduction_due) <= new Date();
  });

  console.log(`Found ${needDeduction.length} harvest enrollments needing deduction out of ${enrollments?.length || 0} total`);

  for (const enrollment of needDeduction) {
    await processSingleHarvestDeduction(enrollment);
  }
}
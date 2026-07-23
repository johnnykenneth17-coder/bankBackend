// Get total balance to check if exceeds limit
    const { data: accounts } = await supabase
      .from("accounts")
      .select("balance, available_balance")
      .eq("user_id", userId);

    const totalBalance =
      accounts?.reduce((sum, acc) => sum + (acc.available_balance || 0), 0) || 0;
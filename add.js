// Check if user has passcode set - HANDLES ALL PHONE FORMATS
app.post("/api/auth/check-passcode", async (req, res) => {
  try {
    const { identifier } = req.body;

    console.log(`Check passcode for identifier: ${identifier}`);

    if (!identifier) {
      return res.status(400).json({ error: "Identifier required" });
    }

    // Check if it's an email
    if (identifier.includes("@")) {
      const { data: user, error } = await supabase
        .from("users")
        .select("id, email, first_name, last_name, passcode_hash, phone")
        .eq("email", identifier.toLowerCase())
        .single();

      if (error || !user) {
        console.log(`No user found for email: ${identifier}`);
        return res.status(404).json({ error: "Account not found" });
      }

      const hasPasscode = !!(user.passcode_hash && user.passcode_hash !== null);

      return res.json({
        has_passcode: hasPasscode,
        user: {
          id: user.id,
          email: user.email,
          first_name: user.first_name,
          last_name: user.last_name,
        },
      });
    }

    // It's a phone number - clean it for comparison
    const cleanPhone = identifier.trim().replace(/\s/g, '');
    console.log(`Cleaned phone for search: ${cleanPhone}`);

    // Get all users (limit to 1000 for performance)
    const { data: users, error } = await supabase
      .from("users")
      .select("id, email, first_name, last_name, passcode_hash, phone")
      .not("phone", "is", null);

    if (error) {
      console.error("Error fetching users:", error);
      return res.status(500).json({ error: "Database error" });
    }

    // Find user by phone number with flexible matching
    let matchedUser = null;

    for (const user of users) {
      if (!user.phone) continue;
      
      const dbPhone = user.phone.replace(/\s/g, '');
      
      // Check multiple formats
      if (dbPhone === cleanPhone) {
        matchedUser = user;
        break;
      }
      
      // Check if cleanPhone matches after removing country code variations
      // For Nigerian numbers: 09123456789 should match +2349123456789
      const cleanPhoneLast10 = cleanPhone.slice(-10);
      const dbPhoneLast10 = dbPhone.slice(-10);
      
      if (cleanPhoneLast10 === dbPhoneLast10 && cleanPhoneLast10.length === 10) {
        matchedUser = user;
        break;
      }
      
      // Check if one has +234 and other has 0
      const cleanPhoneWithoutPlus = cleanPhone.replace(/^\+/, '');
      const dbPhoneWithoutPlus = dbPhone.replace(/^\+/, '');
      
      if (cleanPhoneWithoutPlus === dbPhoneWithoutPlus) {
        matchedUser = user;
        break;
      }
    }

    if (!matchedUser) {
      console.log(`No user found for phone: ${identifier}`);
      return res.status(404).json({ error: "Account not found" });
    }

    const hasPasscode = !!(matchedUser.passcode_hash && matchedUser.passcode_hash !== null);

    console.log(`User found: ${matchedUser.email}, has_passcode: ${hasPasscode}`);

    res.json({
      has_passcode: hasPasscode,
      user: {
        id: matchedUser.id,
        email: matchedUser.email,
        first_name: matchedUser.first_name,
        last_name: matchedUser.last_name,
      },
    });
  } catch (error) {
    console.error("Check passcode error:", error);
    res.status(500).json({ error: "Failed to check passcode: " + error.message });
  }
});
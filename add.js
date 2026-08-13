// Line ~14969
const { account_number, bank_code, bank_name } = req.body;

// Line ~14979 — pass bank_name through
const resolution = await accountResolutionCache.resolveAccount({
  accountNumber: account_number,
  bankCode: bank_code || null,
  bankName: bank_name || null,
  userId: req.user.id,
  maxResults: 5,
});

// Line ~14989 — recordHit is keyed by bank_name now, not bank_code
if (resolution.results.length > 0) {
  accountResolutionCache.recordHit(
    account_number,
    resolution.results[0].bank_name,
  );
}

app.get("/api/cron/cleanup-account-cache", accountResolutionCache.cronHandler);
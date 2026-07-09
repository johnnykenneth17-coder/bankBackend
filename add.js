const billsService = require("./bills-service");
const billsWorker = require("./bills-worker");

app.post(
  "/api/user/bills/verify-pin",
  authenticate,
  checkAccountFrozen,
  billsService.handleVerifyBillPaymentPin,
);
app.post(
  "/api/user/bills",
  authenticate,
  checkAccountFrozen,
  billsService.billPaymentLimiter,
  billsService.handleCreateBillPayment,
);
app.get("/api/cron/process-bills", billsWorker.cronHandler); // add to vercel.json cron config, same pattern as your other workers

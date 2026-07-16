// ============================================================
// index.js wiring — add these lines, do not replace anything else.
// Place near where bills-service.js is currently required/mounted.
// ============================================================

// 1. New requires (alongside the existing bills-service require):
const billsCatalogRouter = require("./bills-catalog-routes");
const billsAdminRouter = require("./bills-admin-routes");

// 2. Mount the public catalog reads. authenticate is applied at the
//    mount point so every route in bills-catalog-routes.js gets it
//    without repeating per-route:
app.use("/api/bills", authenticate, billsCatalogRouter);

// 3. Mount the admin CRUD/analytics routes, same authenticate +
//    authorizeAdmin gate as every other /api/sys/* route in this file:
app.use("/api/sys/bills", authenticate, authorizeAdmin, billsAdminRouter);

// 4. The existing POST /api/user/bills/verify-pin and POST /api/user/bills
//    routes (wired to bills-service.js's handleVerifyBillPaymentPin /
//    handleCreateBillPayment) do NOT need to move or change shape —
//    bills-service.js v2 keeps the same two exports, same route
//    signatures. Just make sure the require points at the new file:
//      const { billPaymentLimiter, handleVerifyBillPaymentPin, handleCreateBillPayment } = require("./bills-service");
//    (unchanged if that's already how it's required today.)

// 5. bills-worker.js's cronHandler is unchanged in shape — whatever
//    route currently wires it to your external cron service keeps
//    working as-is. One behavior note: the commented-out
//    CRON_SECRET check in the old bills-worker.js has been restored
//    (un-commented) in the v2 file — flagging this explicitly since
//    it changes behavior: the bills cron endpoint was accepting
//    requests without checking the Authorization header before, and
//    now requires `Authorization: Bearer <CRON_SECRET>` like the rest
//    of your cron routes. If your external cron service already sends
//    that header (per your existing cron setup), this is a no-op;
//    if not, the bills cron sweep will start returning 401 until it does.
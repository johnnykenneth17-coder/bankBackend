// DELETE this require:
const transferWebhookService = require("./transfer-webhook-service");

// DELETE this route entirely — this is the URL Flutterwave never calls:
app.post(
  "/api/webhooks/flutterwave-transfers",
  express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }),
  transferWebhookService.handleFlutterwaveTransferWebhook,
);

// ADD this — the reconciliation sweep that's been completely unwired until now:
app.get("/api/cron/transfer-webhooks", transferWebhookHandler.cronHandler);
// (transferWebhookHandler is already required near the top for external transfers —
//  just add this one route, and add the path to vercel.json's cron config)
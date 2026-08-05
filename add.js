# BILLS_V3_INDEX_DASHBOARD_PATCH.md
Patches for index.js and dashboard.js — bills v3 metadata/secret-data
upgrade. Apply after 014_bills_v3_metadata_and_secret_data.sql and the
already-delivered bills-worker.js / bills-service.js / payment-provider.js
/ admin-bills-management.js / bills-frontend.js.

Both files below were too large to safely reproduce in full (index.js:
19,150 lines / ~604KB; dashboard.js: 15,831 lines / ~564KB) — these are
exact, minimal, anchored patches instead.

---

## 1. index.js — two changes

### 1a. Mount the two missing/new bill routes

**This fixes a live bug**, independent of the v3 upgrade: `GET
/api/user/bills/:id/status` is exported by bills-service.js but was
never actually mounted anywhere in index.js. bills-frontend.js has been
calling it since the electricity-token feature shipped; every call has
been silently 404ing and getting swallowed by `pollForBillCompletion`'s
"give up quietly" catch block. Nobody would have seen an error — the
electricity token modal (old version) simply never fired.

**Find** (around line 8205):
```js
app.get("/api/cron/process-bills", billsWorker.cronHandler); // add to vercel.json cron config, same pattern as your other workers
```

**Insert immediately after it:**
```js
app.get(
  "/api/user/bills/:id/status",
  authenticate,
  billsService.handleGetBillStatus,
); // was exported but never mounted — bills-frontend.js's status polling has been 404ing silently until now

app.post(
  "/api/user/bills/verify-customer",
  authenticate,
  checkAccountFrozen,
  billsService.handleVerifyCustomer,
);
```

### 1b. Join bill_transactions into the transaction-detail route

`GET /api/user/transactions/:transactionId` (around line 6020) only
ever queried `transactions_new` — there's no bill-specific data (token,
PIN, verification result) on that table, and never has been. This adds
a second query, only for `bill_payment`-type transactions, so the
frontend can offer "View Token/PIN" from transaction history without a
second round-trip on click.

**Find** (around line 6067, right before the security check):
```js
      // SECURITY CHECK: Failed transactions only visible to sender
```

**Insert immediately before it** (i.e. right after the `transaction`
object is built, before the security check block):
```js
      // Bill-payment transactions carry secret data (electricity
      // token, exam PIN, etc.) on bill_transactions, joined via the
      // shared transaction_reference — transactions_new has no such
      // column itself. Attached as transaction.bill so the frontend
      // can offer a "View Token/PIN" action from transaction history
      // without a second round-trip. maybeSingle() (not single()) so
      // a bill_payment-typed row with no matching bill_transactions
      // record (shouldn't happen, but don't 500 if it does) just
      // comes back null instead of throwing.
      if (transaction.transaction_type === "bill_payment") {
        const { data: billRow } = await supabase
          .from("bill_transactions")
          .select(
            "id, status, failure_reason, secret_data, network, customer_identifier, bill_categories(code, name, returns_secret_data, secret_data_label), bill_providers(code, name)",
          )
          .eq("transaction_reference", transaction.transaction_reference)
          .eq("user_id", req.user.id) // ownership check, same guard bills-service.js's status endpoint uses
          .maybeSingle();
        transaction.bill = billRow || null;
      }

```

The existing `res.json(transaction);` a few lines below needs no
change — `transaction.bill` rides along automatically since it's the
same object.

---

## 2. dashboard.js — two changes

### 2a. Carry `transaction.bill` through to the receipt data

**Find** (around line 1290, inside `viewTransactionReceiptFromHistory`,
in the success branch):
```js
        description: transaction.description || transaction.transaction_type,
        transaction_type: transaction.transaction_type,
      };
```

**Replace with:**
```js
        description: transaction.description || transaction.transaction_type,
        transaction_type: transaction.transaction_type,
        bill: transaction.bill || null,
      };
```

### 2b. Add a "View Token/PIN/Voucher" button to the receipt modal

Injected dynamically rather than requiring an index.html edit to the
`#transactionReceiptModal` markup — self-contained, same pattern
bills-frontend.js already uses for its own modals.

**Find** the end of `showTransactionReceipt(transactionData)` (search
for the function, then find its closing `}` — the function is ~150
lines starting at line 3157; the button needs to go in after the
existing DOM-population code, before the function's closing brace).

**Add this new function right after `showTransactionReceipt`'s closing
brace**, and **add one call to it** at the very end of
`showTransactionReceipt`'s body (last line before its own closing `}`):

```js
  // Call as the last line inside showTransactionReceipt(transactionData):
  renderBillSecretDataButton(transactionData);
```

```js
// Shows/hides a "View Token/PIN/Voucher" button on the transaction
// receipt modal when the transaction is a bill payment that returned
// secret data. Reuses bills-frontend.js's universal secret data modal
// (window.BillsFrontend.showSecretDataModal) rather than a second,
// separate token-display implementation — same modal whether it's
// opened right after payment or reopened later from history.
function renderBillSecretDataButton(transactionData) {
  document.getElementById("billSecretDataReceiptBtn")?.remove();

  const secretData = transactionData.bill?.secret_data;
  if (!secretData || !Array.isArray(secretData.items)) return;
  if (!window.BillsFrontend?.showSecretDataModal) return;

  const container =
    document.querySelector("#transactionReceiptModal .modal-content") ||
    document.getElementById("transactionReceiptModal");
  if (!container) return;

  const btn = document.createElement("button");
  btn.id = "billSecretDataReceiptBtn";
  btn.className = "btn btn-primary";
  btn.style.cssText = "width:calc(100% - 40px);margin:0 20px 16px;";
  btn.innerHTML = `<i class="fas fa-key"></i> View ${secretData.title || "Token / PIN"}`;
  btn.addEventListener("click", () => {
    window.BillsFrontend.showSecretDataModal(secretData, {
      amount: transactionData.amount,
    });
  });
  container.appendChild(btn);
}
```

Note: `bills-frontend.js` must load before this button can be clicked
(it's already included after dashboard.js per that file's own header
comment, so by the time a user is viewing transaction history —
necessarily after the page has loaded — `window.BillsFrontend` will be
defined).

### 2c. (Same button, failed-transaction path — optional)

`showTransactionFailedModal` is a separate function/modal from
`showTransactionReceipt` (used for `status === "failed"` in
`viewTransactionReceiptFromHistory`). A failed bill purchase never has
secret_data (finalize_bill_transaction only ever sets it on the
`completed` branch — see 014_bills_v3_metadata_and_secret_data.sql), so
no equivalent button is needed there. Not patched.

---

## Verification checklist after applying both files' patches

1. `curl -X GET https://<host>/api/user/bills/<a real bill_transaction_id>/status` (authenticated) returns 200 with a `secret_data` field, not 404.
2. Buy something in a `returns_secret_data` category (e.g. electricity, once ELECTRICITY is configured with `returns_secret_data = true` in the migration's backfill) — the processing screen should appear, tick through steps, and open the secret data modal automatically.
3. Open Transaction History, click that same purchase — the "View Token" button should appear and reopen the identical modal with the identical value.
4. Buy something in a category with `requires_verification = true` (e.g. CABLE) — should briefly show "Verifying..." then fall through straight to Confirm (since no provider implements `verifyCustomer()` yet) — this is expected, not a bug.
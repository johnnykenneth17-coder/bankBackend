# Support / Live-Chat — Isolated Database Integration Guide

## What this is

A complete replacement for your current `support_tickets` / `chat_messages`
/ `live_support_messages` chat system, rebuilt on a **second, separate
Supabase project** — so a compromise of the chat feature can't reach your
banking database. It also merges "live chat" and "support tickets" into one
thing (a ticket *is* the chat thread), adds the bot flow you described
(issue buttons → canned solution → "was this helpful?" → escalate to a
human with name/email → admin reply → close/reopen), and adds an
admin-manageable list of issue buttons + solutions.

Files delivered:

```
sql/001_support_schema.sql              → run on the NEW Supabase project
backend/lib/support-db.js               → isolated Supabase client
backend/lib/support-security.js         → validation, sanitization, rate limits
backend/lib/support-routes.js           → user-facing API (/api/support/*)
backend/lib/support-admin-routes.js     → admin API (/api/sys/support/*)
frontend/support-widget.js              → user chat widget (dashboard)
frontend/admin-support-management.js    → admin ticket queue + topic CMS
```

## 1. Create the second Supabase project

In the Supabase dashboard, create a **brand-new project** (different from
your banking one). This is what gives you the isolation: it's physically a
different database, on different infrastructure, with its own separate
keys. Grab its **Project URL** and **service_role key** (Settings → API).

Run `sql/001_support_schema.sql` in that project's SQL editor. It creates
`support_topics`, `support_tickets`, `support_messages`, seeds 3 example
topics, and enables RLS with **no policies** (so even the anon key, which
you should never ship to a browser anyway, can't read/write anything).

## 2. Add the new env vars

Add these to your backend's `.env` (and to Vercel/Fly.io/wherever your 5
backends read their env from) — **on every backend host**, same as your
existing `SUPABASE_URL` / `SUPABASE_SERVICE_KEY`:

```
SUPPORT_SUPABASE_URL=https://YOUR-NEW-PROJECT.supabase.co
SUPPORT_SUPABASE_SERVICE_KEY=eyJ...   # the NEW project's service_role key
```

These names are deliberately different from `SUPABASE_URL` /
`SUPABASE_SERVICE_KEY` so they can never be confused with, or accidentally
default to, your bank database's credentials.

## 3. Copy the backend files in

Copy `backend/lib/support-db.js`, `support-security.js`,
`support-routes.js`, `support-admin-routes.js` into your backend's `lib/`
folder (next to `bills-admin-routes.js` etc. — same folder your `index.js`
already does `require("../lib/...")` from).

`npm install zod` if you haven't already (validation.js already needs it;
if that file is wired in, you're done). `express-rate-limit` is already a
dependency (used by `authLimiter` etc. in index.js).

## 4. Mount the routes in index.js

Add near your other router requires (next to `billsAdminRouter` etc.):

```js
const supportRoutes = require("../lib/support-routes");
const supportAdminRoutes = require("../lib/support-admin-routes");
```

And near your other `app.use("/api/sys/...")` / `app.use("/api/user/...")`
mounts:

```js
// User-facing support/chat — isolated Supabase project, see support-db.js
app.use("/api/support", authenticate, supportRoutes);

// Admin support queue + bot topic management
app.use("/api/sys/support", authenticate, authorizeAdmin, supportAdminRoutes);
```

That's it on the backend. Nothing else in `index.js` needs to change — the
new routes don't touch the existing `support_tickets` / `chat_messages` /
`live_support_messages` tables or the Socket.IO live-chat block at all.

### Retiring the old chat system

Once the new widget is live and you're happy with it:

- Remove (or stop calling) `loadLiveChat()` in `dashboard.js` and the
  `live_support_messages` Socket.IO handlers in `index.js` (the block
  starting at the `io.on("connection", ...)` you already have). They're
  independent of the new system, so this is optional cleanup, not a
  blocker — but leaving both running means two separate "contact support"
  systems exist side by side, which will confuse users.
- The old `/api/user/tickets`, `/api/user/tickets/:id/messages` routes and
  the `support_tickets` / `chat_messages` tables in your **main** bank
  database can be dropped once you've migrated off them — they're what
  you're moving away from.

## 5. Add the widget to the user dashboard

In `index.html` (or wherever the dashboard's `<script>` tags live), add
**after** `backend-config.js` and `dashboard.js`:

```html
<script src="support-widget.js"></script>
```

It self-injects a floating support button — no HTML container needed. If
you have an existing "Contact Support" nav item/button you'd rather use
instead of the floating bubble, point its `onclick` at:

```js
SupportWidget.open();
```

and remove the old `loadLiveChat()` call from that handler.

## 6. Add the admin Support page

In `admin.html`, add a nav item (same pattern as your other admin pages,
e.g. "Bills Management") that sets the active page to
`support-management`, and add the container:

```html
<div class="admin-page" id="page-support-management"></div>
```

In `admin.js`'s page-switch dispatch, add:

```js
case "support-management":
  initSupportManagement();
  break;
```

Include the script after `admin.js`:

```html
<script src="admin-support-management.js"></script>
```

Gate visibility the same way you gate Bills Management in
`admin-permissions.js`, if you want a specific admin role/permission
required to see the Support tab.

## Security summary (what's actually protecting this)

- **Database isolation**: separate Supabase project, separate keys, no
  foreign keys into bank tables. A breach of the chat DB yields ticket
  text + names/emails — never balances, accounts, or credentials.
- **RLS enabled, zero policies**: even a leaked anon key for the support
  project (which is never generated/shipped anyway) gets nothing.
- **Server-mediated only**: the browser never talks to Supabase directly.
  Every read/write goes through your Express routes, which validate with
  Zod (`support-security.js`) before anything touches the database.
- **XSS**: message/name/title text is stripped of HTML tags server-side
  on write (defense in depth), and rendered **exclusively** via
  `textContent`/DOM-node construction on both the user widget and admin
  panel — never `innerHTML` with interpolated data. Don't add an
  `innerHTML = message` anywhere in either frontend file.
- **SQL injection**: not applicable — every query goes through Supabase's
  query builder (`.eq()`, `.insert()`, ...), which parameterizes values.
  Nothing here builds a raw SQL string from user input.
- **Rate limiting**: ticket creation is capped per IP+email; messages are
  capped per IP+ticket; reads are lightly capped too — stops a scripted
  flood of the admin queue or an inbox-bombing attack.
- **Ownership checks**: every user-facing ticket/message route re-verifies
  `bank_user_id === req.user.id` from the (already-verified) bank JWT
  before returning or accepting anything — one user cannot read or post
  into another user's ticket by guessing a ticket ID.
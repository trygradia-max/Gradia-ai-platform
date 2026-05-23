# Jobber go-live walkthrough

Most working detailers use Jobber for invoicing and scheduling.
Gradia sits on top instead of replacing it — approved leads and
bookings push into the shop's Jobber account as clients + requests.

## What ships today

- OAuth (authorization code) wired end-to-end.
- Tokens encrypted at rest via `ENCRYPTION_KEY`; refresh tokens
  auto-rotate when access tokens expire (~1h).
- `/settings#jobber` card with Connect / Disconnect.
- `lib/jobber.ts`: `findClient`, `createClient`, `findOrCreateClient`,
  `createRequest`, `fetchAccountInfo`, raw `jobberGraphQL` caller.
- `lib/jobber-push.ts`: orchestration helpers called from the
  approval engine. Best-effort throughout — Jobber failures log
  but never roll back a Gradia-side approval.
- **`create_lead` approval** → find-or-create Jobber Client (by
  phone, falling back to email), mirror the Jobber client id onto
  `customers.jobber_client_id` so we don't create duplicates on
  the next push.
- **`book_appointment` approval** → same client find-or-create,
  then create a Jobber Request titled `"{service} — {customer}"`
  with the agreed time as `preferredStartAt`. Mirror the request
  id onto `appointments.jobber_request_id`.
- Customer detail (`/customers/[id]`) shows a "Synced" Jobber row
  on the identity card when `jobber_client_id` is set.

## Operator steps

### 1. Register the Jobber developer app

Sign in at <https://developer.getjobber.com> and create a new app.

- **Redirect URI:**
  `https://YOUR_GRADIA_DOMAIN/api/jobber/auth/callback`
  (local dev: an ngrok tunnel to your dev server)
- **Scopes** (request all of these):
  - `read_clients`, `write_clients`
  - `read_requests`, `write_requests`
  - `read_quotes`, `write_quotes`

Save the app. Jobber will give you a **Client ID** and **Client
Secret**.

### 2. Set env vars in Vercel

```
JOBBER_CLIENT_ID=<from step 1>
JOBBER_CLIENT_SECRET=<from step 1>
```

Both are server-only — never expose them to the browser.

### 3. Apply the migration

```
supabase db push
```

Applies `20260521100000_shop_jobber.sql` — adds the encrypted
token columns to the `shops` table.

### 4. Click Connect

In Gradia → `/settings` → **Jobber** card → **Connect Jobber**.
You'll be redirected to Jobber to authorize. On success you land
back on `/settings?jobber=ok` with a green "Connected" pill
showing the Jobber account name.

If anything goes wrong, the redirect carries a status code
(`?jobber=token_exchange_failed`, etc.) and the card surfaces it
as a toast.

## How tokens get refreshed

`getAccessTokenForShop` in `lib/jobber.ts` checks expiry on every
call. If the access token is within 60 seconds of nominal
expiry, it calls `refresh_token` and persists the new tokens
before returning. Concurrent calls don't double-refresh because
the second one reads the freshly-persisted access token.

If the refresh itself fails (revoked token, etc.), the helper
throws `JobberError(401)` and the caller should treat that as
"tell the operator to reconnect."

## Known limitations

- One-way push (Gradia → Jobber) only. No inbound webhooks yet, so
  changes the shop makes in Jobber don't flow back. The shop's
  Jobber dashboard remains the source of truth for job state.
- Single-account-per-shop. A shop running multiple Jobber accounts
  picks one.
- Client matching uses `searchTerm` against phone or email — first
  match wins. Best-effort; if a shop has multiple Jobber clients
  sharing the same phone, the first one Jobber returns gets the
  push.
- Requests, not Jobs, are what we create. Requests are Jobber's
  intake/quote-pending entity. The shop converts to a Job + Quote
  inside Jobber when they're ready.

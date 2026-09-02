# Gradia — Environment & Config Setup

_Single checklist for taking Gradia live. Grounded in the actual `process.env.*`
the code reads (verified 2026-06-01). Pairs with the per-provider runbooks:
`vapi-go-live.md`, `aurinko-go-live.md`, `twilio-go-live.md`, `stripe-go-live.md`,
`jobber-go-live.md`._

## How to set these

- **Production:** set every var in your host's project settings (Vercel →
  Project → Settings → Environment Variables). **Never commit `.env.local`.**
- **Local dev:** copy values into `.env.local` (gitignored). `.env.example` is
  the committed template.
- **Scope key:** `secret` = server-only, never expose. `public` =
  `NEXT_PUBLIC_*`, shipped to the browser (safe by design). `build` = only
  needed at build time.
- **Public URL:** webhooks (Vapi, Twilio, Aurinko, Stripe) and OAuth redirects
  need a stable HTTPS origin. Set `GRADIA_DASHBOARD_URL` to your real domain —
  several absolute URLs (Slack links, Stripe redirects, `/billing`) derive from it.

> 📋 **Production presence audit (2026-09-01, PROD-CONFIG-AUDIT):** `docs/gradia-v2/runbooks/production-config-audit.md` — every `process.env` read in `src/` classified required / required-for-feature / optional / deprecated, with the PRESENT · ABSENT · UNKNOWN table and exactly which UI surfaces each absent var disables. It also lists what is stale in this file (§3.3).

> ⚠️ `.env.example` is currently **missing** four keys the code reads — add them:
> `STRIPE_PRICE_ID`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `META_APP_ID`,
> `VAPI_API_KEY`. (Ask me to sync the template.)

> ⏭️ **Auto-provided — do not set:** `NODE_ENV`, `VERCEL_ENV`,
> `NEXT_PUBLIC_VERCEL_ENV`, `NEXT_RUNTIME`.

---

## Tier 1 — Core (required to boot)

| Var | Scope | Purpose | Where |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | public | Supabase project URL | Supabase → Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | public | Supabase anon key | same |
| `SUPABASE_SERVICE_ROLE_KEY` | secret | Server-only writes (webhooks, approvals, cron) bypass RLS | Supabase → Settings → API |
| `ANTHROPIC_API_KEY` | secret | Claude — drafting, classifying, planning, BI | console.anthropic.com |
| `OPENAI_API_KEY` | secret | Embeddings (memory/RAG) + Whisper transcription | platform.openai.com |
| `ENCRYPTION_KEY` | secret | AES-256-GCM for per-shop tokens at rest. **64 hex chars:** `openssl rand -hex 32` | generate |
| `CRON_SECRET` | secret | Auth for `/api/cron/*` (reminders + scheduled agents). Fails closed if unset. `openssl rand -hex 32` | generate |
| `GRADIA_DASHBOARD_URL` | secret | Your production origin, e.g. `https://app.yourdomain.com` | your domain |

**After setting these + deploying:** apply all Supabase migrations
(`supabase db push`) — including `20260601100000_credits_billing.sql`. The
dashboard, memory/RAG, approvals, and agent builder now work. No channels yet.

Cron note: `vercel.json` already registers the hourly crons; Vercel sends
`Authorization: Bearer $CRON_SECRET` automatically.

---

## Tier 2 — Approvals surface (optional — Slack is opt-in)

In-app `/approvals` is the default (Phase 1). Leave these unset to run in-app
only. Set them + flip `FEATURES.slackApprovals = true` to also post to Slack.

| Var | Scope | Purpose |
|---|---|---|
| `SLACK_WEBHOOK_URL` | secret | Incoming-webhook fallback for approval cards |
| `SLACK_SIGNING_SECRET` | secret | Verifies Approve/Edit button callbacks |
| `SLACK_BOT_TOKEN` | secret | `xoxb-…` — enables `chat.update` (fixes stale cards) |
| `SLACK_DEFAULT_CHANNEL_ID` | secret | Channel the bot posts to (with bot token) |

---

## Tier 3 — The 3 MVP integrations + channels

Each integration is **account → keys (here) → dashboard config → one "Connect"
click in `/settings`**. They're independent; do them in any order.

### Calendar + Email — Aurinko  (`aurinko-go-live.md`, `calendar-go-live.md`)
| Var | Scope | Purpose |
|---|---|---|
| `AURINKO_CLIENT_ID` | secret | Aurinko app id |
| `AURINKO_CLIENT_SECRET` | secret | Aurinko app secret |
| `AURINKO_SIGNING_SECRET` | secret | Verifies inbound email webhooks |

Then **Connect Gmail** in `/settings` (one OAuth click, per shop). Calendar
rides on the same connection. Google may require OAuth-app verification for the
Gmail/Calendar scopes — file that with Google.

### CRM — Jobber  (`jobber-go-live.md`)
| Var | Scope | Purpose |
|---|---|---|
| `JOBBER_CLIENT_ID` | secret | Jobber developer app id |
| `JOBBER_CLIENT_SECRET` | secret | Jobber developer app secret |

Redirect URL in the Jobber app: `https://YOUR_DOMAIN/api/jobber/auth/callback`.
Then **Connect Jobber** in `/settings`.

### Voice — Vapi  (`vapi-go-live.md`)
| Var | Scope | Purpose |
|---|---|---|
| `VAPI_API_KEY` | secret | Vapi account key _(missing from `.env.example`)_ |
| `VAPI_WEBHOOK_SECRET` | secret | Set as the assistant's "Server URL Secret" (`x-vapi-secret`) |
| `VAPI_DEFAULT_SHOP_ID` | secret | Optional single-shop dev fallback; leave blank in prod |

Provision a phone number (costs $), point the assistant's Server URL at
`https://YOUR_DOMAIN/api/vapi/webhook`, paste the assistant ID in `/settings`.

### SMS — Twilio  (`twilio-go-live.md`)
| Var | Scope | Purpose |
|---|---|---|
| `TWILIO_ACCOUNT_SID` | secret | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | secret | Twilio auth token |

Buy a number, set it in `/settings`, point its messaging webhook at
`https://YOUR_DOMAIN/api/twilio/sms`. **US: complete A2P 10DLC brand/campaign
registration** or carriers will filter your texts.

---

## Tier 4 — Paywall (only when you want to charge $20/mo)

| Var | Scope | Purpose |
|---|---|---|
| `STRIPE_SECRET_KEY` | secret | Platform key (`sk_live_…`) |
| `STRIPE_PRICE_ID` | secret | The $20/mo recurring Price id (`price_…`) _(missing from `.env.example`)_ |
| `STRIPE_WEBHOOK_SECRET` | secret | `whsec_…` for `/api/stripe/webhook` |

Webhook events to subscribe (platform endpoint): `checkout.session.completed`,
`customer.subscription.updated`, `customer.subscription.deleted` (plus the
existing `invoice.paid` / `invoice.payment_failed` / `charge.refunded`).

Then ask me to **flip `FEATURES.paywall = true`** and set new shops to default
`free`. Until then the dashboard gate + credit fail-closed stay inert. Tune
`CREDIT_COST` in `src/lib/credits.ts` to your pricing.

---

## Hidden for MVP — not needed now

These power surfaces gated off in `src/lib/features.ts`. Skip until you un-hide them.

| Var | For |
|---|---|
| `STRIPE_CONNECT_CLIENT_ID`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Stripe **Connect** (charging the detailer's customers — the hidden Billing agent) |
| `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN` | Instagram + Facebook DMs (`meta-go-live.md`) |

---

## Observability (optional)

| Var | Scope | Purpose |
|---|---|---|
| `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` | secret / public | Error capture (server / browser). Empty DSN = no-op. |
| `SENTRY_ENVIRONMENT` / `NEXT_PUBLIC_SENTRY_ENVIRONMENT` | secret / public | Environment tag |
| `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN` | build | Source-map upload at build time only |

---

## Feature flags (config-as-code, not env)

`src/lib/features.ts` is the single switchboard. Current MVP state:

- `paywall: false` → flip `true` after Tier 4 is wired + verified.
- `slackApprovals: false` → flip `true` to also post approvals to Slack.
- `freeformPlanner: true` → the free-form chat agent (executor + guardrails live).
- `agents.instagram/billing: false`, `integrations.instagram/facebook/payments: false` → hidden.

---

## Minimum viable "live"

Smallest set that boots a usable product (no channels, no billing):
**Tier 1 only.** Add channels one at a time from Tier 3, and Tier 4 when you're
ready to charge. Slack (Tier 2) is entirely optional.

## Pre-launch checklist
- [ ] Tier 1 set in Vercel; all migrations applied (incl. P3)
- [ ] `GRADIA_DASHBOARD_URL` = real domain; HTTPS live
- [ ] At least one Tier 3 channel connected + smoke-tested
- [ ] (If charging) Tier 4 set, webhook subscribed, `FEATURES.paywall=true`
- [ ] A2P 10DLC done (if SMS), Google OAuth verified (if Gmail)
- [ ] Secrets only in host env; any previously-exposed keys rotated
- [ ] Privacy policy + terms published

---

## CI environment (P0-002)

_What the gating workflows need. Values here are **names only** — CI holds no
production secret of any kind._

**`ci.yml` (job `checks`: secret hygiene → typecheck → lint → tests → build):**

- Required env vars: **none.** Verified 2026-07-30: `npx tsc --noEmit`,
  `npm run lint`, `npm test`, and `npm run build` all pass with zero env vars
  set — the app defers missing-env failures to runtime by design. If a future
  change makes `next build` demand a variable, add an obviously-fake
  `ci-placeholder-*` value in the workflow's `env:` block with a comment; never
  a real key, and never a value the app could mistake for a live connection.

**`ci-integration.yml` (job `integration`: DB-backed approval-engine tests):**

- `SUPABASE_TEST_URL` / `SUPABASE_TEST_SERVICE_ROLE_KEY` — generated **inside
  the job** by `supabase start` (a disposable local stack booted from
  `supabase/migrations`, torn down every run). They are NOT GitHub secrets, are
  never stored, and cannot reach production data. The export step fails loud if
  either is missing.
- Supabase CLI is pinned (see the workflow) — bump deliberately, only after a
  green run on the new version.

**Required GitHub repository secrets/variables for the gating workflows: none.**

**Kept OUT of required CI:** the live-model tiers (`npm run eval`, gated by
`EVAL_LIVE=1`, needs `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`) run on-demand
locally; a scheduled/path-filtered live-eval workflow is pending founder
decision Q-06 (`docs/gradia-v2/program/decision-queue.md`). Live-provider
verification items stay in the vendor docs — they are never repository checks.

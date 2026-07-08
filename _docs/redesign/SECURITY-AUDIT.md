# Security Audit — Gradia platform + marketing

_Read-only audit, 2026-07-07. No secret values appear in this document; credentials are referred to by name and location only. Findings are ordered by severity. Fixes require founder approval (this doc + the rotation runbook are the only writes made)._

Scope: `platform/` and `marketing/` repos (git history + settings), the platform's webhook/auth/RLS surface, dependency advisories, and the PR #2 branch diff (`/security-review`).

---

## CRITICAL

### C-1 — Production database credential committed to a PUBLIC repo → IMMEDIATE-ROTATE
- **What:** A full Supabase Postgres connection string **including the database password** is committed as a line in `platform/.gitignore` (**line 46**, `SUPABASE_DB_URL postgres://…`). The `postgres` role bypasses RLS entirely.
- **Where:** introduced in commit **`ca95047`** ("WIP checkpoint…"), present on branches **`redesign/glass-box`** and **`mvp/phase-0-subtraction`** and **both of their `origin` branches on the public GitHub repo** (`trygradia-max/Gradia-ai-platform` is `private: false`). **Not** on `origin/main`.
- **Exposure window:** public since those branches were pushed (~July 2). Treat as **compromised** — automated credential-harvesting bots crawl public pushes within minutes.
- **Impact:** direct `postgres://` superuser access to the production database — full read/write of every shop's data and all encrypted-token blobs, RLS bypassed, ability to drop tables.
- **How it slipped past tooling:** `gitleaks detect --all` reported *no leaks* — the `KEY<space>postgres://…` shape inside `.gitignore` evaded its default ruleset (documented false negative). Found via manual diff review in `/security-review`.
- **Transparency note:** this line pre-existed **uncommitted** in the working `.gitignore` before this session. The session's WIP-checkpoint commit (`ca95047`) captured it and a later `git push` published it to the public remote. Reporting faithfully: the push is part of the exposure chain.
- **Fix (see `KEY-ROTATION-RUNBOOK.md` §1, do first):**
  1. **Rotate the Supabase database password now** (Supabase → Project Settings → Database → Reset database password).
  2. Delete line 46 from `.gitignore` on both branches (keep the legitimate `.env*` line the same commit added).
  3. Public history means removal ≠ remediation — rotation is the real fix. Optionally scrub history (`git filter-repo`) + force-push, and make the repo private (see M-1).

---

## MEDIUM

### M-1 — Both repos are PUBLIC
- `platform` and `marketing` are both `private: false`. A commercial pre-launch product with billing, telephony, and customer PII should not have a world-readable source tree — it turns any future credential slip (see C-1) into instant compromise and exposes the full data model / attack surface.
- **Fix:** make both repos private (GitHub → Settings → Danger Zone → Change visibility) unless there's a deliberate open-source decision. Low effort, high payoff.

### M-2 — No branch protection on `main` (both repos)
- `GET /branches/main/protection` → 404 "Branch not protected" for **both** repos. No required reviews, no required status checks, admins can force-push to production `main`.
- **Fix:** enable branch protection on `main`: require PR + ≥1 review, require the CI status check to pass, restrict force-push. (The redesign shipped via PR #2 by good practice, not by enforcement.)

### M-3 — marketing `.gitignore` under-matches env files
- marketing `.gitignore` uses `.env` and `.env*.local` — which do **not** match `.envlocal`, `.envanything`, or `.env.production.pull`-style names. A stray empty file **`.envlocal`** is in fact committed (commit `1cf28cc`, tracked on all branches, **not** ignored).
- **Verified not an active leak:** `.envlocal` has been **0 bytes across its entire history** (checked every blob) — no secret was ever committed through it. But the ignore gap means a future non-empty `.envlocal` would be committed silently.
- **Fix:** change marketing `.gitignore` to the broader `.env*` (as platform uses), and `git rm --cached .envlocal`.

---

## LOW / INFORMATIONAL

### L-1 — Automated secret scanner produced a false negative
- gitleaks 8.30.1 full-history scan of `platform` reported "no leaks found" yet **missed C-1**. Do not rely on gitleaks alone; pair it with diff review and a pre-commit hook. Consider adding a custom gitleaks rule for `postgres(ql)?://` connection strings and a `SUPABASE_DB_URL` allowlist-free rule.

### L-2 — Vapi webhook verification has no unit-test coverage
- Every other inbound webhook verifier is covered in `eval/webhooks.test.ts`; the Vapi per-shop-secret path (`secretMatches`/`verifyVapiSecret`) is not. The code is correct (timing-safe, fail-closed, verified before side effects) but a regression wouldn't be caught. **Fix:** add cases (valid per-shop secret, valid env fallback, wrong secret, both-missing → reject).

### L-3 — Dependency advisories (report only, per instructions — do not upgrade)
- **platform** `npm audit`: 17 total — **2 high** (`hono`: IPv6 IP-restriction bypass + Set-Cookie injection; `ws`: uninitialized-memory disclosure + DoS), 14 moderate, 1 low. Both highs have fixes available; confirm whether `hono`/`ws` are on a reachable server path or transitive/dev before prioritizing.
- **marketing** `npm audit`: 6 total — **2 high** (`next` itself; `ws`), 4 moderate.

---

## Areas audited and found CLEAN

- **Inbound webhook signature verification** — all 7 routes (Vapi, Twilio SMS/status/A2P, Stripe, Aurinko, Slack) verify **before** any side effect, use `crypto.timingSafeEqual`, fail **closed** when the secret env var is missing, and reject unsigned payloads with 401. Stripe/Aurinko/Slack additionally enforce a 5-minute replay window.
- **Auth on API routes** — all 7 cron routes require `Authorization: Bearer CRON_SECRET`, fail closed; `admin/margin-report` same; `mcp` uses per-shop bearer tokens; `agent/chat`, `bi/chat`, `whisper/process`, `recovery/import` require `requireUser()`/`requireShop()` + credit gate. No unauthenticated write or tenant-data route found.
- **Server actions** — all mutating actions call `requireUser()`/`requireShop()` before writing. The new `undoRejectFromDashboard` is `shop_id`-scoped and only un-rejects (no send).
- **RLS on the new Glass Box tables** — `call_records` and `action_decisions` both `ENABLE ROW LEVEL SECURITY` with the standard `shop_id IN (SELECT id FROM shops WHERE owner_id = (SELECT auth.uid()))` USING+WITH CHECK policy, matching convention. Readers (`lib/data/activity.ts`, `call-records.ts`) use the **RLS** client (`createClient` from `supabase/server`), not the service client, with defense-in-depth `.eq("shop_id", …)`.
- **New readers / call-record page** — Supabase query builder throughout (parameterized; the URL `callId` flows into `.eq()`, no string-built SQL). Transcript + recording render via React auto-escaping; no `dangerouslySetInnerHTML`. No injection or stored-XSS introduced.
- **`.env` hygiene (platform)** — only `.env.example` (template) is tracked; `.env.local` and `.env.production.pull` are gitignored (`.env*`). No env file ever held committed bytes in platform history **except** the C-1 line, which lives in `.gitignore` itself.

---

## Secret inventory

Every credential the platform expects (from `.env.example`), where it's read, where it lives, and blast radius on rotation. **Rotation order and procedure: `KEY-ROTATION-RUNBOOK.md`.**

| Secret (name only) | Read at | Lives in | Breaks on rotation |
|---|---|---|---|
| Supabase **DB password** (`SUPABASE_DB_URL`) | migrations / direct psql; **leaked in `.gitignore` (C-1)** | Supabase dashboard (should NOT be in repo) | Direct DB tooling / migrations; app uses the API keys, not this |
| `SUPABASE_SERVICE_ROLE_KEY` | `src/lib/supabase/service.ts` (all webhooks, cron, service paths) | Vercel env + `.env.local`(local stack value) | Every webhook, cron, and service-role write — app-wide backend |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `supabase/server.ts`, client | Vercel env + `.env.local` | All RLS-scoped reads/writes; user sessions |
| `NEXT_PUBLIC_SUPABASE_URL` | supabase clients | Vercel env | Everything Supabase |
| `ENCRYPTION_KEY` ⚠️ | `src/lib/crypto.ts` (AES-256-GCM) | Vercel env + `.env.local` | **DO-NOT-ROTATE-BLINDLY** — decrypts all `*_enc` columns (Aurinko/Gmail, Jobber, Housecall Pro, per-shop Twilio SID/auth/subaccount, Vapi server secret). Blind rotation bricks every shop's integrations. See runbook §6. |
| `ANTHROPIC_API_KEY` | drafters, agent runtime, BI | Vercel env + `.env.local` | All LLM drafting/planning |
| `OPENAI_API_KEY` | Whisper transcription, embeddings | Vercel env + `.env.local` | Whisper + memory search |
| `STRIPE_SECRET_KEY` | `lib/stripe.ts`, connect routes, settings | Vercel env | Billing, checkout, Connect |
| `STRIPE_WEBHOOK_SECRET` | `lib/stripe.ts` | Vercel env + Stripe dashboard | Stripe webhook verification (two-sided) |
| `STRIPE_CONNECT_CLIENT_ID`, `STRIPE_PRICE_*`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | billing/connect | Vercel env / Stripe | Connect onboarding, price lookups, client checkout |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | `lib/twilio.ts`, settings | Vercel env (+ per-shop `*_enc` in DB) | Platform-level SMS send + inbound signature verification |
| `VAPI_API_KEY` | `lib/vapi.ts`, settings, onboarding | Vercel env | Voice assistant provisioning/control |
| `VAPI_WEBHOOK_SECRET` | `api/vapi/webhook/route.ts` (env fallback) | Vercel env (+ per-shop `vapi_server_secret_enc`) | Vapi webhook verification for legacy assistants |
| `AURINKO_CLIENT_ID/SECRET/SIGNING_SECRET` | `lib/aurinko.ts` + callback | Vercel env | Gmail/calendar OAuth + webhook verification |
| `JOBBER_CLIENT_ID/SECRET`, `HOUSECALLPRO_CLIENT_ID/SECRET` | CRM libs + callbacks | Vercel env | CRM OAuth flows |
| `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `SLACK_WEBHOOK_URL` | `lib/slack.ts` | Vercel env | Optional Slack approvals (flagged off) |
| `SENTRY_*` / `NEXT_PUBLIC_SENTRY_*` | instrumentation | Vercel env | Error reporting (non-functional impact) |
| `CRON_SECRET` | all `api/cron/*` + admin | Vercel env (+ Vercel Cron config) | All scheduled jobs (agents, reminders, reconcile, receipt, no-show, recovery, voice-sync) |
| `META_*` | dormant (IG/FB removed) | Vercel env | Nothing live |

Note: `.env.production.pull` (the local prod snapshot) contains only a subset of the above — the authoritative production secret set lives in **Vercel env**. `.env.example` is the authoritative list of what the app expects.

---

## Audit gaps (disclosed)

- **marketing full-history secret scan was interrupted** by the founder and not completed. Manual blob-size checks confirmed no `.env*` file ever held committed bytes in marketing, but a full gitleaks pass (with the L-1 caveat that gitleaks can false-negative) was not run. Recommend completing it with founder approval before treating marketing history as cleared.

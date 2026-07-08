# Key Rotation Runbook — Gradia platform

_Companion to `SECURITY-AUDIT.md`. Dashboard-by-dashboard rotation order. No secret values appear here. Do these top-to-bottom; two-sided secrets (webhook signing) must be updated in the vendor dashboard AND Vercel in the same maintenance window or you drop live traffic._

## Conventions
- **Where prod secrets live:** Vercel → Project → Settings → Environment Variables (Production). Deployed runtime reads from there — **not** from any local file.
- **`.env.production.pull`** is a local read-only snapshot; after rotating anything, re-pull it: `npx vercel env pull .env.production.pull` (never load it into a running process — see `LOCAL-DEV.md`).
- **`.env.local`** points at the LOCAL supabase stack + local model keys — unaffected by prod rotation except the shared model keys (§3).
- **Redeploy rule:** Vercel env changes only take effect on the **next deployment**. After changing any server-read secret, trigger a redeploy (Vercel → Deployments → Redeploy, or push an empty commit). Secrets read only at build time additionally need a fresh build. Client (`NEXT_PUBLIC_*`) secrets are inlined at build → always require a rebuild.

---

## §1 — FIRST, TODAY: Supabase database password (leaked, C-1)
1. Supabase → Project Settings → **Database → Reset database password**. Generate a new strong password.
2. This connection string (`postgres://`) is **not read by the app** (the app uses the anon/service API keys), so app runtime is unaffected — but any local psql/migration tooling, and the Supabase CLI `db push`, must be re-pointed to the new password.
3. **Remove line 46 from `.gitignore`** on `redesign/glass-box` and `mvp/phase-0-subtraction`; commit + push. Keep the `.env*` line.
4. Because the old password was public, rotation is the remediation; optionally scrub history (`git filter-repo --path .gitignore --invert-paths` is too broad — use a targeted replacement) + force-push, and make the repo private.
5. **No redeploy needed** (app doesn't read it).

---

## §2 — Supabase API keys (service role + anon)
> Rotate only if you suspect these leaked (they are NOT in C-1; C-1 is the DB password). If rotating:
1. Supabase → Project Settings → **API → Rotate** the `service_role` and/or `anon` keys.
2. **Immediately** update Vercel env: `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (Production).
3. **Redeploy** (anon is `NEXT_PUBLIC_` → build-time inlined → requires a rebuild; service role is server-runtime).
4. Re-pull `.env.production.pull`.
5. **Blast radius during the gap:** between key rotation and redeploy, the live app authenticates with the old key → **all reads/writes and webhooks fail**. Keep the window short; rotate → update Vercel → redeploy back-to-back.

---

## §3 — Model provider keys (Anthropic, OpenAI)
1. Anthropic Console / OpenAI dashboard → create new key, then revoke old.
2. Update Vercel `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` (Production) **and** local `.env.local` (these two are shared into local dev).
3. **Redeploy.** Gap impact: drafting/BI (Anthropic) or Whisper+embeddings (OpenAI) return errors until redeploy.

---

## §4 — Two-sided webhook signing secrets (Stripe, Twilio, Vapi)
These verify inbound webhooks. The vendor signs with their copy; the app verifies with the Vercel copy. **They must match at all times** — rotate both sides in one window, and expect a few seconds of verification failures mid-swap (vendors retry, so no data is lost if you're quick).

**Stripe** (`STRIPE_WEBHOOK_SECRET`, and `STRIPE_SECRET_KEY` if that leaked):
1. Stripe Dashboard → Developers → Webhooks → your endpoint → **roll signing secret** (Stripe supports a dual-secret grace window — use it).
2. Set the new `STRIPE_WEBHOOK_SECRET` in Vercel → **redeploy**.
3. For `STRIPE_SECRET_KEY`: create a new restricted/secret key, update Vercel, redeploy, then revoke the old.

**Twilio** (`TWILIO_AUTH_TOKEN`):
1. Twilio Console → Account → **Auth Token → rotate** (Twilio lets you promote a secondary token — use the secondary-token flow to avoid a hard cutover).
2. Update Vercel `TWILIO_AUTH_TOKEN` → **redeploy**.
3. ⚠️ Inbound SMS signature verification uses this token; per-shop BYO numbers use their own `*_enc` tokens (encrypted with `ENCRYPTION_KEY`, unaffected here).

**Vapi** (`VAPI_WEBHOOK_SECRET` env fallback, `VAPI_API_KEY`):
1. Vapi Dashboard → rotate the API key / server-URL secret.
2. Update Vercel → **redeploy**.
3. ⚠️ Most assistants use per-shop `vapi_server_secret_enc` (encrypted with `ENCRYPTION_KEY`); the env `VAPI_WEBHOOK_SECRET` is only the legacy fallback.

---

## §5 — OAuth app secrets, Slack, Sentry, CRON_SECRET
- **Aurinko / Jobber / Housecall Pro** client secrets: rotate in each vendor's developer console, update Vercel, redeploy. Existing per-shop tokens (`*_enc`) keep working; only new OAuth handshakes use the client secret.
- **Slack** (`SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`): Slack app admin → regenerate; update Vercel; redeploy. (Slack approvals are flag-off, low impact.)
- **Sentry** (`SENTRY_AUTH_TOKEN`, DSNs): rotate in Sentry; DSNs are `NEXT_PUBLIC_` → rebuild. Non-functional impact.
- **`CRON_SECRET`**: rotate the Vercel Cron bearer. Update it in Vercel env **and** in the Vercel Cron job config that sends the `Authorization` header, in the same window — else every scheduled job 401s. Redeploy.

---

## §6 — ENCRYPTION_KEY ⚠️ DO-NOT-ROTATE-BLINDLY
**What it protects:** `src/lib/crypto.ts` uses `ENCRYPTION_KEY` with **AES-256-GCM** to encrypt/decrypt these at-rest columns:
`aurinko_access_token_enc`, `jobber_access_token_enc`, `jobber_refresh_token_enc`, `housecallpro_access_token_enc`, `housecallpro_refresh_token_enc`, `twilio_account_sid_enc`, `twilio_auth_token_enc`, `twilio_subaccount_token_enc`, `vapi_server_secret_enc` (+ dormant `facebook_/instagram_page_access_token_enc`).

**Why blind rotation is destructive:** every stored blob was encrypted with the *current* key. Change `ENCRYPTION_KEY` and **every existing shop's** Gmail/calendar sync, CRM sync, per-shop SMS sending, and per-shop Vapi webhook auth breaks instantly — the app can no longer decrypt what it stored. There is no automatic re-encryption.

**Only rotate with a migration:**
1. Add a second env var (e.g. `ENCRYPTION_KEY_NEXT`) and teach `crypto.ts` to **decrypt with old, encrypt with new** (dual-key read, single-key write).
2. Run a one-off migration that, per row, decrypts each `*_enc` column with the old key and re-encrypts with the new key.
3. Verify all shops' integrations still work, then promote `ENCRYPTION_KEY_NEXT` → `ENCRYPTION_KEY` and remove the old.
4. This is a **planned engineering task**, never an incident-response quick rotation. If `ENCRYPTION_KEY` itself is believed compromised, the priority is to also rotate every *underlying* vendor token it protected (Twilio/Vapi/Aurinko/Jobber/HCP), because those plaintexts are what an attacker with the key + DB would recover.

---

## §7 — Post-rotation smoke checklist
Run after any rotation window (all on production, one real shop):
- [ ] **Login** — owner can sign in (magic link / Google) → dashboard loads (validates anon key + session).
- [ ] **One inbound call** — place a test call to a provisioned number → it's answered, and a **`call_records` row + transcript appear** in `/activity` and `/calls/[id]` (validates Vapi key + webhook secret + service-role write + the L0.5 capture).
- [ ] **One SMS** — text the shop number → inbound is received and a draft is staged in `/approvals` (validates Twilio auth token + inbound signature verify + service-role write).
- [ ] **One Stripe event** — trigger a test webhook (Stripe CLI `stripe trigger` or a test checkout) → it verifies and processes (validates `STRIPE_WEBHOOK_SECRET` two-sided match).
- [ ] **One cron** — manually hit a cron route with the new `CRON_SECRET` bearer → 200, not 401.
- [ ] **Existing-shop integration** (only if §6 touched) — an already-connected shop's Gmail/CRM/voice still works (validates `*_enc` decryption).
- [ ] Confirm no Sentry flood of auth/verification errors after the window closes.

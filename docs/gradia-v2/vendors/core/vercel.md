# Vendor — Vercel

> **Classification:** core · **Status:** core · Amended 2026-07-27 (vendor-architecture amendment, D-030/ADR-002). Registry: ../registry.md

_Created 2026-07-25 by the Organizer. Vendor registry entry. Facts grounded in the 2026-07-20 audit (docs 02, 10, 12); unverified items are marked. See `08-security-and-reliability.md` and ticket `P0-010`._

## Purpose
Hosting and runtime for the Next.js 16 app (single deployable modular monolith) and its scheduled background work: 8 cron routes registered from `vercel.json` (reminders, no-show ladder, roi-receipt, recovery-retention, automations/agents sweeps, voice-sync, reconciliation).

## Data exchanged
All application traffic. Environment variables hold every vendor secret (Anthropic, OpenAI, Twilio, Vapi, Aurinko, Stripe, Supabase keys, `ENCRYPTION_KEY`, `CRON_SECRET`).

## Authentication
Cron routes authenticate with `Bearer CRON_SECRET`, fail-closed if unset. Deploy auth = Vercel account access (founder). `main` = production — merges deploy.

## Webhooks
None consumed from Vercel. Crons auto-register from `vercel.json` on deploy (GO_LIVE_CHECKLIST §3).

## Rate limits
Function execution limits: audit notes a hung LLM fetch "rides to Vercel's 60s kill" — actual configured timeouts and plan limits REQUIRES VERIFICATION (Vercel dashboard).

## Failure behavior
No queue, no retry, no dead-letter (audit doc 02): a failed cron sweep waits for the next tick; weekly jobs have no catch-up. Cron failures alert nowhere until P0-012. CI cannot currently stop a broken build reaching main = production (P0-002).

## Idempotency
Not provider-side. Cron sweeps rely on Gradia-side stamps/`trigger_ref` (check-then-insert, race-prone — P0-005).

## Cost model
Part of the ~$0.50/shop/month infra assumption (`15-cost-and-margin-model.md`). Actual plan REQUIRES VERIFICATION.

## Monitoring
Vercel dashboard shows cron registration/runs (GO_LIVE_CHECKLIST §3 verifies the crons appear). No alerting wired; ties to P0-012. Deployment notifications REQUIRES VERIFICATION.

## Test environment
Preview deploys exist (GO_LIVE_CHECKLIST uses a preview/staging deploy for the recovery smoke). No dedicated staging environment established in repo; REQUIRES VERIFICATION.

## Known audit gaps
- Five env vars used by code but undocumented in `.env.example` (`STRIPE_PRICE_VOICE_ADDON`, `STRIPE_PRICE_CREDIT_PACK`, `STRIPE_PRICE_MINUTE_PACK`, `STRIPE_API_BASE`, `GLOBAL_DAILY_COST_CEILING_CENTS`) — whether they are set in prod REQUIRES VERIFICATION (audit open question #15; ticket P0-010).
- `VAPI_DEFAULT_SHOP_ID` must be unset in production (footgun; P0-010, audit open question #18).
- No health endpoint (P0-012); no structured logging (E10).
- CI depth: typecheck/lint/build not enforced before deploy (P0-002).

## Backup or exit strategy
Stateless compute — state lives in Supabase/Stripe. Exit = re-host the Next.js app + re-create the cron schedule elsewhere; real but contained work. The Vercel-cron dependency is the main coupling (E10 outbox/queue reduces it). Accepted risk; no exit planned.

## Owner
Founder (Harry).

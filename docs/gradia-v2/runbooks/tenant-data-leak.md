# Runbook — Tenant Data Leak

_Created 2026-07-25 by the Organizer. Gradia's tenancy is RLS on session paths but **pure code discipline (`.eq("shop_id")`) across ~29 service-role files** (audit docs 05/06). The known proof-of-pattern is C-2: `claimPendingAction` has no shop binding on the Slack service-role path (dormant only because `FEATURES.slackApprovals=false`, locked off by D-026). Hardening ticket: **P0-011**; mechanism: E01._

## Trigger / symptoms
- An owner reports seeing another shop's customer, lead, quote, call, or approval card.
- Code review or audit finds a service-role query missing its `shop_id` filter.
- A webhook/cron path resolved the wrong shop (e.g. `VAPI_DEFAULT_SHOP_ID` routing unmatched assistants to a real shop).

## Severity
**SEV-0 by default.** Downgrade only with evidence that no cross-tenant row was ever returned or written (e.g. the flaw is provably unreachable, like C-2 behind its disabled flag → risk row, not incident).

## Immediate containment
1. **Close the path, don't fix it live:** flip the owning feature flag in `src/lib/features.ts` and redeploy (`emergency-feature-shutdown.md`), or for a cron path rotate `CRON_SECRET` (all crons fail closed), or for a webhook path disable the webhook at the provider console (Twilio/Vapi/Aurinko/Stripe) so signature-verified traffic stops arriving.
2. If the vector is a leaked credential rather than app code, switch to `exposed-credential.md`.
3. Preserve evidence before any cleanup: export the offending rows and relevant Vercel function logs.

## Diagnosis
- Identify the exact query and its inputs. Determine the **read vs write** direction — a cross-tenant *write* (e.g. a foreign `customer_id` landing under your `shop_id`, the `vehicles.ts:184-195` shape) also corrupts the receiving tenant.
- Scope: which shops, which rows, what time window. Use the audit trail: `pending_actions` (who claimed/executed), `custom_agent_runs`, `action_decisions`, `interactions`, `usage_events`, Vercel logs, Sentry.
- Check whether the same missing-filter pattern exists elsewhere: grep every `createServiceClient()` importer for the touched table (the P0-011 review checklist is the template).

## Recovery
- Delete or re-home mis-scoped rows; write compensating ledger entries where money was touched (never edit ledgers — D-024).
- Land the code fix with a **tenant-isolation test** that fails without it (extend, never weaken — D-012).
- Re-enable the closed path only after the test is green in CI.

## Verification
- The new tenant-isolation test passes; replaying the triggering request against a two-shop fixture returns/creates rows in exactly one tenant.
- Affected owners' data spot-checked back to correct shape.

## Communication
- Mandatory, same-day, per-shop honest notice to **both** sides of a leak (exposed-from and exposed-to), stating exactly which records were visible/written and for how long. No guesses — scope first, then notify (`incident-severity.md`).

## Postmortem
- Why discipline missed it; whether `forShop()` (P0-011 design) or RLS-for-service-role would have caught it mechanically; update risk R-02.
- Every postmortem action lands as a ticket; if the answer is "wait for E01", say so explicitly and accept the interim risk in the register.

## Known gaps
- No automated cross-tenant detection — leaks surface via humans today (alerts: P0-012).
- The two SQL RPCs (`match_customer_memory`, `match_shop_knowledge`) trust the caller's `p_shop_id` — same discipline model.
- Single-owner tenancy means "wrong user in the shop" incidents don't exist yet; E01 (members/roles) will require this runbook to grow a permissions section.

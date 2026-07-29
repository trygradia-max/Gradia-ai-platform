# Runbook — Duplicate Messaging

_Created 2026-07-25 by the Organizer. Customers of a shop received the same SMS/email more than once, or the approvals inbox is filling with duplicate cards. Until **P0-005/P0-006/P0-007** land, inbound webhooks are not idempotent — a normal Twilio/Aurinko/Vapi retry duplicates interactions, Claude classification spend, and staged approval cards (audit doc 04 traces F/G/H). Duplicate *sends* additionally implicate automations/autopilot._

## Trigger / symptoms
- Owner reports a customer got the same text twice; duplicate rows in `interactions` with the same body minutes apart; two identical cards in `/approvals`.
- `usage_events` shows doubled `message` metering for one logical send.
- Overlapping cron runs double-firing an automation (check-then-insert race on `automation_runs.trigger_ref` — no unique index, audit doc 05 weakness 6).

## Severity
- Duplicates actually **delivered to customers** across shops: **SEV-1** (the product's professionalism promise, plus per-segment credit burn).
- Duplicate **cards only** (human caught them pre-approve): **SEV-2**.

## Immediate containment
1. **Stop autonomous sending:** set affected automations to approval mode / disable autopilot per shop (per-automation toggles), or globally flip the relevant flags in `src/lib/features.ts` and redeploy. Dropping a shop's Package-2 entitlement degrades everything to suggest-first (entitlement kill switch).
2. **Pause crons** if sweeps are the source: rotate `CRON_SECRET` in Vercel env (all 8 cron routes fail closed) — accept the collateral pause of reminders/reconciliation and note it.
3. Leave HITL staging on — staged duplicates are harmless while a human is filtering; tell the owner to Dismiss dupes rather than approve.

## Diagnosis
- Which seam duplicated? Compare provider ids: Twilio `MessageSid` / Aurinko `aurinko_message_id` in `interactions.metadata` (inbound dupes), `pending_actions` created seconds apart with identical payloads (staging dupes), `automation_runs` rows sharing a `trigger_ref` (sweep race), `usage_events` rows for the same send (metering echo).
- Check provider dashboards for retry storms (Twilio debugger, Aurinko delivery logs) — retries are usually *caused* by our webhook returning non-2xx; find that error in Vercel logs/Sentry first.

## Recovery
- De-duplicate staged cards (Dismiss); do **not** delete `interactions` history without noting it — memory rows feed the shared brain.
- Refund credits for duplicate sends via a compensating `credit_grants` entry (never edit `usage_events` — D-024).
- Land or expedite the matching idempotency ticket (P0-005/006/007) — this runbook firing is the priority argument.

## Verification
- Replay the captured webhook payload twice against a test shop: exactly one interaction, one card, one meter row (this is the P0-005/006/007 acceptance test).
- 24h watch on `interactions` for id-duplicate rows.

## Communication
- The **owner** decides whether their customer gets an apology — Gradia speaks as the shop; offer drafted copy, never send it unbidden.
- Owner notice includes the credit make-good amount, framed in real numbers (D-028).

## Postmortem
- Root cause class (webhook retry vs cron race vs double-approve — note `claimPendingAction` is atomic, so double-approve should be impossible; if it happened, that's its own SEV).
- Update risk R-04.

## Known gaps
- No inbound idempotency until P0-005/006/007 — this runbook is the manual compensation for a known defect.
- No queue/dead-letter (E10): a paused cron loses its window; weekly jobs have no catch-up.
- Cooldown/opt-out keying misses leads with no linked customer — dupes to those numbers also escape cooldown logic.

# Runbook — Calendar Outage

_Created 2026-07-25 by the Organizer. Today the external calendar is load-bearing: `executeBookAppointment` **hard-requires a connected Aurinko/Google calendar and fails closed** (`approvals.ts:686` gate — audit trace D). An Aurinko outage or a shop's disconnected/expired token means **no appointment can confirm** for that shop. E02 (D-013: Gradia DB becomes the appointment source of truth) removes this dependency; until then this runbook is the compensation._

## Trigger / symptoms
- Approving a booking in `/approvals` fails and the card rolls back to pending (the executor's rollback-on-failure is sound — expect stuck-pending cards, not corruption).
- Voice/quote bookings stage fine but nothing can confirm.
- Aurinko webhook silence (no inbound email interactions either — the email channel shares the provider; see `ai-provider-outage.md` for the classifier-flood variant).
- Single-shop variant: token expired/revoked — transparent refresh exists (60s buffer) but a hard revocation needs re-auth, and **there are no owner-facing reconnect alerts today** (audit doc 03: integration reconnect PARTIAL).

## Severity
- Provider-wide Aurinko outage: **SEV-2** (bookings blocked across shops, but fail-closed — nothing corrupts; staged approvals wait).
- Multi-day outage in season, or silent single-shop disconnection losing bookings: escalate to **SEV-1**.

## Immediate containment
1. Confirm scope: one shop (token) vs all shops (provider). Check Aurinko status page + a token-refresh attempt in logs.
2. **Do not bypass the gate.** The fail-closed behavior is correct — a booking without a calendar event would silently break the owner's real-world schedule. No flag exists to skip it; do not hot-patch one in an incident.
3. Tell affected owners: approvals will hold; booked times promised to customers should be tracked manually until confirm succeeds (honest, per D-028).
4. Single-shop token death: owner re-runs the calendar connection (Settings → centered OAuth popup).

## Diagnosis
- Vercel logs for `executeBookAppointment` failures and `aurinko.ts` refresh errors; Sentry.
- `pending_actions` where `action_type='book_appointment'` and status pending/rolled-back accumulating per shop = blast radius list.
- Distinguish Aurinko-API failure from Google-side failure (Aurinko fronts Google) — matters only for ETA honesty.

## Recovery
- When the provider recovers, approve the held cards — the executor re-runs idempotently (rollback-to-pending was designed for this).
- Verify each recovered booking landed once: one calendar event, one `appointments` row (aurinko ids stamped), one confirmation SMS **staged** (not sent twice — check `/approvals`).
- Re-run the reminder cron window mentally: reminders are stamped idempotently (`reminder_pending_action_id` set before notify), but a booking confirmed *after* its 23–25h reminder window silently gets no reminder — send one manually if it matters.

## Verification
- One test booking end-to-end on a real shop; appointment visible on `/calendar` and in Google.
- No orphaned calendar events without `appointments` rows (the partial-failure shape audit doc 09 notes — sequential calls, no transaction).

## Communication
- Per `incident-severity.md`; frame as "bookings held for your approval, nothing lost" when true — verify before claiming.

## Postmortem
- Feed the pain into E02 prioritization (this is the standing argument for D-013).
- If a single shop was dark for days unnoticed: that is the missing reconnect-alert surface — ticket it (P0-012 adjacency / backlog).
- Update risk R-13.

## Known gaps
- Hard Aurinko dependency until E02; no degraded "book internally, sync later" mode exists today.
- No owner-facing disconnection alerts; discovery is manual.
- Drag-reschedule and block-time also touch calendar paths — include them in verification.

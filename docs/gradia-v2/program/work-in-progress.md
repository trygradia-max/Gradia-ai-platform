# Program — Work In Progress

_Created 2026-07-25 by the Organizer. The live WIP board. **Every Builder session checks this file before starting any work** — that is an invariant, not a courtesy. The Organizer is the only role that edits it._

## WIP limits (binding, from `../README.md`)

1. Maximum **two** active implementation tickets at any moment.
2. Maximum **one** database-sensitive ticket active at a time (anything adding/altering tables, indexes, RLS, or migrations).
3. Maximum **one** payment, tenancy, or calendar **high-risk** ticket active at a time — one slot shared across all three categories.
4. Exactly **one Builder and one Reviewer per ticket** — never two builders on one ticket, never one session in both roles.
5. **No ticket enters implementation until its dependencies and decisions are resolved** (`dependency-map.md`, `decision-queue.md`, `blocked.md`).

## Current board (Sprint 1, as of 2026-07-25)

| Slot | Ticket | Risk class | Builder | Reviewer | State |
|---|---|---|---|---|---|
| Active 1 | P0-001 — Exposed database credential remediation | Security (standard) — reclassified 2026-07-27, no schema/migration impact | Claude Builder (session 2026-07-29) | _open — assign one Cursor Reviewer_ | **in-review** (accuracy update 2026-08-06: merged to `main` 2026-07-30, PR #8 `6adc21c`; held out of done pending founder acceptance steps 2 & 6 + formal Reviewer sign-off; slot stays occupied until done) |
| Active 2 | — freed 2026-08-14 — | — | — | — | **P0-006 done** (merged PR #19 `76847e4` 2026-08-14; pre-squash `afb542b` Builder implementation → `89af55c` metering retry-safety fix; independent Cursor verdict **APPROVE / safe to merge**, no BLOCKER/HIGH, no review-fix commit; founder real-Twilio staging acceptance completed pre-merge; close record in `../tickets/P0-006-twilio-inbound-replay-protection.md`. Board note: like P0-004/P0-004A/P0-005, this ticket ran founder-slotted without a board entry recorded at start — recorded here retroactively for accuracy). Previous occupant P0-005 done 2026-08-13 (PR #17, close record in its ticket file). Slot reserved next for **P0-007** (Vapi transcript and usage replay protection — next implementation position, currently **blocked** pending the P0-006 closeout merge; see `blocked.md`), which enters in-progress only when unblocked, the Organizer slots it, and a Builder is recorded here — not started. |
| Database-sensitive | — empty — | — | — | — | Slot free. P0-006 shipped no migration (rode the P0-005 schema; P0-005's migrations `20260812120000`/`20260812130000` + unapplied rollback closed 2026-08-13). P0-005A expects no migration (confirm at slotting); ADR-001 expects P0-007 to add no schema — its ticket predates P0-005 and lists a migration; reconcile at slotting. |
| High-risk (payments/tenancy/calendar) | — empty — | — | — | — | Free since the P0-004A (calendar) close, 2026-08-11. P0-005/P0-006 did not occupy it; P0-007 (payment/metering class) will when slotted. |

Slot accounting: 1/2 active · **0/1 database-sensitive** · 0/1 high-risk. One active slot free — reserved for P0-007 (blocked pending closeout merge; unblock condition in `blocked.md`).

## How this board is updated

- **Start:** the Organizer moves a ticket from `current-sprint.md`/`backlog.md` into a slot only when limits allow and entry conditions pass; the ticket file's Status flips to in-progress.
- **Finish:** Builder posts the completion report (per `../agent-briefs/claude-builder.md`) → Reviewer signs off against `../12-definition-of-done.md` → Organizer clears the slot and flips the ticket to done.
- **Block:** a blocked ticket moves to `blocked.md` and frees its slot.
- **Never:** a Builder self-assigns, swaps tickets mid-flight, or starts "just a small extra fix" outside a slotted ticket. Out-of-scope discoveries go to `backlog.md` via the completion report.

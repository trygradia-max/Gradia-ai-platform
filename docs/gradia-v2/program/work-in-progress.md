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
| Active 2 | — freed 2026-08-25 — | — | — | — | **P0-008 done** (merged PR #23 `1ea198f` 2026-08-25; pre-squash `ffd6e01` Builder, implemented 2026-08-18; independent Cursor verdict **APPROVE**, no BLOCKER/HIGH; founder acceptance PASSED on isolated local staging — both credential classes through the real staged send path, forged/tampered/cross-tenant/unknown-SID negative matrix, replay durability, clean reconciliation; close record in `../tickets/P0-008-twilio-subaccount-status-callback-repair.md`. Board note: like P0-004 through P0-007, this ticket ran founder-slotted without a board entry recorded at start — recorded here retroactively for accuracy; it entered after the `docs/close-p0-007` closeout landed as `9babfcb` PR #22, exactly per its unblock condition). Previous occupant P0-007 done 2026-08-14 (PR #21, close record in its ticket file). Slot reserved next for **P0-009** (Quote acceptance, lead linkage and expiration repair — next implementation position, currently **blocked** pending the P0-008 closeout merge; see `blocked.md`), which enters in-progress only when unblocked, the Organizer slots it, and a Builder is recorded here — not started. |
| Database-sensitive | — empty — | — | — | — | Slot free. P0-008 shipped no migration (as its spec declared — metadata updates only); P0-007 and P0-006 also shipped none; P0-005's migrations closed 2026-08-13. P0-005A expects no migration (confirm at slotting); P0-009 expects none (confirm at slotting). |
| High-risk (payments/tenancy/calendar) | — empty — | — | — | — | Free since the P0-007 (payment/metering) close, 2026-08-14 — P0-008 was not high-risk class and never occupied it. P0-009 is money-path correctness (quotes) — the Organizer rules on its risk class at slotting. |

Slot accounting: 1/2 active · **0/1 database-sensitive** · 0/1 high-risk. One active slot free — reserved for P0-009 (blocked pending closeout merge; unblock condition in `blocked.md`).

## How this board is updated

- **Start:** the Organizer moves a ticket from `current-sprint.md`/`backlog.md` into a slot only when limits allow and entry conditions pass; the ticket file's Status flips to in-progress.
- **Finish:** Builder posts the completion report (per `../agent-briefs/claude-builder.md`) → Reviewer signs off against `../12-definition-of-done.md` → Organizer clears the slot and flips the ticket to done.
- **Block:** a blocked ticket moves to `blocked.md` and frees its slot.
- **Never:** a Builder self-assigns, swaps tickets mid-flight, or starts "just a small extra fix" outside a slotted ticket. Out-of-scope discoveries go to `backlog.md` via the completion report.

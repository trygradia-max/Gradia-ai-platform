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
| Active 1 | P0-001 — Exposed database credential remediation | Security (standard) — reclassified 2026-07-27, no schema/migration impact | Claude Builder (session 2026-07-29) | _open — assign one Cursor Reviewer_ | **in-review** (2026-07-29 — repo remediation implemented; founder acceptance steps 2 & 6 + Reviewer + merge to `main` outstanding; slot stays occupied until done) |
| Active 2 | — freed 2026-07-30 — | — | — | — | **P0-002 done** (merged PR #9, Cursor Reviewer APPROVE; completion record in the ticket file). Slot reserved next for **P0-003**, which enters in-progress only when the Organizer slots it and a Builder is recorded here — not started. |
| Database-sensitive | — empty — | — | — | — | Slot free until P0-005 (the first genuinely DB-sensitive P0 ticket) |
| High-risk (payments/tenancy/calendar) | — empty — | — | — | — | P0-003 takes this slot when it starts (its P0-002 gate cleared 2026-07-30) |

Slot accounting: 1/2 active · **0/1 database-sensitive** · 0/1 high-risk. One active slot free — reserved for P0-003 as the next active implementation ticket.

## How this board is updated

- **Start:** the Organizer moves a ticket from `current-sprint.md`/`backlog.md` into a slot only when limits allow and entry conditions pass; the ticket file's Status flips to in-progress.
- **Finish:** Builder posts the completion report (per `../agent-briefs/claude-builder.md`) → Reviewer signs off against `../12-definition-of-done.md` → Organizer clears the slot and flips the ticket to done.
- **Block:** a blocked ticket moves to `blocked.md` and frees its slot.
- **Never:** a Builder self-assigns, swaps tickets mid-flight, or starts "just a small extra fix" outside a slotted ticket. Out-of-scope discoveries go to `backlog.md` via the completion report.

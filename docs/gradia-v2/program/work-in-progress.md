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
| Active 2 | P0-003 — Central appointment conflict service | **Calendar (high-risk)** — occupies the shared high-risk slot below | Claude Builder (session 2026-07-30, founder-slotted on `fix/p0-003-appointment-conflict-service`) | _open — assign one Cursor Reviewer_ | **in-review** (2026-07-30 — service + tests implemented, no call sites wired; completion record in the ticket file; Organizer to confirm this founder-directed slotting) |
| Database-sensitive | — empty — | — | — | — | Slot free until P0-005 (the first genuinely DB-sensitive P0 ticket) |
| High-risk (payments/tenancy/calendar) | P0-003 (calendar) | Calendar | Claude Builder (2026-07-30) | _open_ | Occupied while P0-003 is active; P0-004 waits for this slot |

Slot accounting: 2/2 active · **0/1 database-sensitive** · 1/1 high-risk. No active slot free; P0-004 queues behind P0-003's review.

## How this board is updated

- **Start:** the Organizer moves a ticket from `current-sprint.md`/`backlog.md` into a slot only when limits allow and entry conditions pass; the ticket file's Status flips to in-progress.
- **Finish:** Builder posts the completion report (per `../agent-briefs/claude-builder.md`) → Reviewer signs off against `../12-definition-of-done.md` → Organizer clears the slot and flips the ticket to done.
- **Block:** a blocked ticket moves to `blocked.md` and frees its slot.
- **Never:** a Builder self-assigns, swaps tickets mid-flight, or starts "just a small extra fix" outside a slotted ticket. Out-of-scope discoveries go to `backlog.md` via the completion report.

# Program — Current Sprint

_Created 2026-07-25 by the Organizer. Sprint 1 (P0 Stabilization). Started 2026-07-25 · target: alpha 2026-08-07 (**date-vs-gate policy open — Q-25 in `decision-queue.md`**; do not silently relax the P0 exit gate). Governs live sprint state; tickets in `../tickets/`, limits also mirrored in `work-in-progress.md`._

## Sprint goal

Land the two tickets that everything else depends on — **P0-001** (the leaked database credential is rotated and scrubbed from the working tree) and **P0-002** (CI can actually stop a broken build from reaching `main` = production). Nothing from P1+ enters this sprint. Sprint 1 contains **only P0 stabilization work** (epic E00).

Rationale: audit doc 00 names the credential leak the single most serious issue; audit doc 12 orders it first ("nothing else ships until 1–2 land"). P0-002 must complete before any other ticket enters review, because reviewers need a CI that can fail.

## Active implementation tickets

| Ticket | Title | Status | Risk class | Builder | Reviewer |
|---|---|---|---|---|---|
| P0-001 | Exposed database credential remediation | **in-review** (accuracy update 2026-08-06: **merged to `main` 2026-07-30** in PR #8, commit `6adc21c` — the credential is out of HEAD and the regression lock is live in CI; still held out of done pending founder acceptance steps 2 & 6 and formal Reviewer sign-off; Q-01 history decision open) | **Security (standard)** — reclassified 2026-07-27: the ticket declares no schema/migration impact, so it does NOT occupy the DB-sensitive slot (WIP definition = tables/indexes/RLS/migrations) | Claude Builder (session 2026-07-29) | _unassigned — one Cursor Reviewer_ |
| P0-002 | CI typecheck, lint, build and integration enforcement | **done** (2026-07-30 — merged to `main` in PR #9, commit `7e3d530`; Cursor Reviewer verdict APPROVE, no BLOCKER/HIGH findings; completion record in the ticket file) | Standard | Claude Builder | Cursor Reviewer (APPROVE) |

Founder action inside P0-001: the actual password rotation happens in the Supabase dashboard — only the founder can do it. The Builder prepares everything around it (scrub `.gitignore:46`, env updates, delete `.env.local` backups, verification steps). The git-history-scrub sub-step is **blocked** on decision Q-01 (see `blocked.md`) — rotation is NOT blocked by it.

## Queued behind this sprint

- **P0-003** (Central appointment conflict service) — **done 2026-08-06**: merged to `main` in PR #10 (`00091db`), Cursor Reviewer APPROVE, CI + DB integration green. The service (`src/lib/availability.ts`) is **inert until P0-004 wires it** — no booking path changed, no migrations. Merge/review record in the ticket file.
- **P0-004** (Conflict enforcement across booking and scheduling paths) — now the **next active implementation ticket**: ready, first in line for the freed calendar high-risk slot. Its 12 entry gates from the P0-003 close are recorded in the ticket. **Implementation has not started** — it enters in-progress only when the Organizer slots it and a Builder is recorded in `work-in-progress.md`.

## WIP limits (restated, binding)

| Limit | Rule | Current state |
|---|---|---|
| Active implementation tickets | max **2** | 1 active (P0-001 in-review); P0-002 done 2026-07-30 — its slot is free, reserved next for P0-003 ✓ |
| Database-sensitive tickets active | max **1** | **0** — slot empty until P0-005 (P0-001 reclassified 2026-07-27: no schema/migration impact) ✓ |
| Payment / tenancy / calendar high-risk tickets active | max **1** | 0 — P0-003 released the calendar slot at close (2026-08-06); **P0-004 takes it when slotted** ✓ |
| Roles per ticket | exactly one Builder + one Reviewer | slots defined above ✓ |
| Entry condition | no ticket enters implementation until dependencies and decisions are resolved | P0-001/P0-002 have no unresolved blockers (Q-01 blocks only the optional history-scrub sub-step) ✓ |

## Definition of sprint success

1. P0-001 done: old credential fails to connect; `.gitignore:46` line gone from HEAD; backup env files deleted; rotation documented (per the ticket's DoD).
2. P0-002 done: a deliberate type error fails CI; lint + `next build` run on every push; `ci-integration.yml` runs green without `continue-on-error`. — **MET 2026-07-30** (PR #9; secret hygiene, typecheck, lint, deterministic tests, build, and DB integration all blocking; GitHub requires `ci / checks` + `ci-integration / integration` on `main`; evidence in the ticket's completion record).
3. Both pass Cursor Reviewer sign-off against `12-definition-of-done.md`.
4. `blocked.md` and `decision-queue.md` updated with anything discovered mid-sprint.

## Carry-over rules

- An unfinished ticket carries into Sprint 2 **keeping its slot** — it is not re-scoped mid-flight.
- A ticket that fails review returns to in-progress under the same Builder; it does not free a WIP slot.
- If a founder decision blocks a ticket mid-sprint, the ticket moves to `blocked.md` and its slot frees; the Organizer may promote the next ready ticket that respects the limits.
- Scope discovered mid-ticket goes to `backlog.md` as a follow-up ticket — never absorbed silently.

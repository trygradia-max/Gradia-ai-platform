# Program — Release Calendar

_Created 2026-07-25 by the Organizer. Known dates and the cadence model. Release gates and record format live in `../13-release-strategy.md`; per-release records in `../releases/`._

## Fixed dates

| Date | Event | Gate |
|---|---|---|
| **2026-08-07** | **Alpha launch** (set 2026-07-08, root `CLAUDE.md`) | P0 exit: all 12 E00 tickets done + reviewed; `GO_LIVE_CHECKLIST.md` smokes passed; owner acceptance runs complete. |
| Before alpha (undated) | **home-redesign branch merge** | Finish the branch's own Phase 5 verify (tsc, eslint, vitest, manual pass per `HOME_REDESIGN_PLAN.md`); reconcile `BUILD_REFERENCE.md` §3 (contradiction C-08). |
| Before alpha (undated, founder) | Live-contract verifications | First real A2P registration; Vapi/voice acceptance run (unlocks the voice claim per `WHAT_GRADIA_DOES.md`); prod env audit (5 missing vars, `VAPI_DEFAULT_SHOP_ID` unset). |

## Cadence model (proposal — founder sets actual dates)

Post-alpha releases are **phase-gated, not date-gated**: a release ships when its phase's exit criterion in `../10-roadmap.md` is met and the Release Reviewer signs off — never because a calendar date arrived. The founder pins target dates per phase as pilot feedback firms up; the Organizer records them here when set.

| Milestone | Trigger (not a date) |
|---|---|
| Alpha hardening release(s) | Individual P0-ticket batches may ship to prod as they pass review — flags off where risky. Shipped so far: P0-001 (PR #8, 2026-07-30) · P0-002 (PR #9, 2026-07-30) · P0-003 (PR #10, 2026-08-06) · P0-004 (PR #12, 2026-08-11 — conflict enforcement wired on every path, dormant behind `NEXT_PUBLIC_GRADIA_CONFLICT_ENFORCEMENT`) · P0-004A (PR #15, 2026-08-11 — booking atomicity/concurrency, live immediately regardless of the flag) · **P0-005 (PR #17, 2026-08-13 — webhook idempotency foundation: `provider_events` claiming, ledger uniques, SELECT-only ledger RLS; production duplicate audit zero rows pre-merge; staging manual acceptance still gates full rollout acceptance of the migrations; see `../releases/README.md`)**. The P0-004 production flag flip remains a release event, gated only on founder manual acceptance (P0-004A hardening gate satisfied). |
| P1 tenancy release | E01 exit: second user invitable with a role; isolation is mechanism. |
| P2 calendar release | E02 exit: booking works with no external calendar connected. |
| Subsequent phases | Per roadmap exit criteria, sequentially. |

## Claim-promotion checkpoints (D-028)

Marketing claims move planned → beta → live only at these checkpoints, tied to `GO_LIVE_CHECKLIST.md` §4–6 smokes:

- **Voice receptionist / business numbers** — claimable only after the telephony acceptance run passes (currently "built, not claimable").
- **Customer recovery** — claimable only after the full NEXT-3 smoke passes on staging and the flag flips.
- **CRM C1–C8 surfaces** — demoable/marketable only after prod migrations + live end-to-end smoke + real-export C7 import test.
- **Housecall Pro** — no claim until live-endpoint verification (see `blocked.md`).
- Each promotion updates `_docs/WHAT_GRADIA_DOES.md` in the same release (rule in `../13-release-strategy.md`).

## Standing rules

- No release on a red or bypassed CI — **in force since 2026-07-30**: P0-002 landed (PR #9) and GitHub branch protection on `main` requires `ci / checks` and `ci-integration / integration` (secret hygiene, typecheck, lint, deterministic tests, production build, and the DB-backed integration tier are all blocking). Live-provider/model evals remain outside CI pending Q-06 — they are not part of this gate.
- Flag-gated features may merge ahead of their release; the **flag flip** is the release event and gets its own record in `../releases/`.
- The Organizer updates this file whenever the founder sets or moves a date; date changes are recorded, never overwritten silently.

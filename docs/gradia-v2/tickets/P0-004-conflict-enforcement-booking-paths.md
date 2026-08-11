# P0-004 — Conflict enforcement across booking and scheduling paths

- **Ticket ID:** P0-004
- **Epic:** E00 — Stabilization
- **Status:** **done** (2026-08-11 — merged to `main` in PR #12, commit `3b6d044`; CI `ci / checks` + `ci-integration / integration` green on the merge; two review rounds addressed on-branch (`d43ce16` Cursor findings, `c0b66b1` founder rollout/failure-policy directives); enforcement is **dormant in production** — `NEXT_PUBLIC_GRADIA_CONFLICT_ENFORCEMENT` defaults OFF; the production flag flip is the release event and is gated on the manual acceptance run — merge & review record at the end of this file)
- **Priority:** High (risk class: **calendar** — counts against the high-risk WIP limit; may not run concurrently with P0-003)

## Objective

Wire the P0-003 availability service into **every** path that creates or moves time on the calendar, applying D-015 (automatic → hard-block) and D-016 (human-approved → warn with documented override). After this ticket, no booking path in the product can silently double-book.

## User outcome

- A voice caller asking for a taken slot hears that it's taken and is offered to try another time.
- An owner approving a booking sees a conflict warning on the approval card and must explicitly override to proceed; the override is recorded.
- Autonomous/automated bookings against a busy slot are refused, visibly.

## Current code references

All from audit doc 04-D and doc 12 item 3:

- `approvals.ts:663` `executeBookAppointment` (the one booking executor; rolls back to pending on failure).
- Voice `proposeBooking` — `vapi-tools.ts:365` (stages `book_appointment`; the tool response is what the caller hears).
- Quote acceptance booking staging — `actions/quote-response.ts` (`respondToQuote` `:69`, accept-with-time path `:135`).
- Reschedule paths: HITL reschedule action + drag-reschedule (`rescheduleJob` per audit doc 12 item 3).
- `blockTime` action (audit doc 03 "Blocked times: OPERATIONAL").
- Approval card UI (ApprovalCard component per `docs/BUILD_REFERENCE.md` §6) — conflict warning surface.
- `maybeAutoExecute` (`agent-runtime.ts:1952-2001`) — the autonomous execution gate where `hitl` vs `automatic` context is decided.

## Exact scope

1. **Staging-time check (advisory):** when `book_appointment` / reschedule actions are staged (voice tool, quote accept, agent runtime), run `checkAvailability` and attach the result to the action payload so the approval card can render it. Voice: on conflict, the tool result tells the assistant the slot is unavailable so it offers alternatives — the assistant must not stage a knowingly-conflicting booking without saying so.
2. **Execution-time check (authoritative):** inside `executeBookAppointment` (and the reschedule executor), re-check availability at claim time (data may have changed since staging):
   - Context `automatic` (autopilot/`maybeAutoExecute`): conflict → refuse, action rolls back to pending with the conflict recorded on the card (D-015). Never silently drop.
   - Context `hitl`: conflict → require an explicit override flag on the approval (set by the owner in the UI after seeing the warning); execute + record the `ConflictOverride` (who/when/conflicts) in the decision log / action payload (D-016).
3. **blockTime + drag-reschedule:** same check; these are owner-direct (hitl context) → warn in UI with override confirm.
4. **Approval card UI:** render the conflict warning (icon + text, semantic warning tokens, per BUILD_REFERENCE — status never color-alone); "Approve anyway" is the documented override affordance. Copy in `strings.ts`.
5. Analytics events for conflict-encountered / conflict-overridden / conflict-blocked (names coordinated with `../14-product-analytics.md` conventions).
6. Index migration if P0-003's completion report recommended one (this ticket is then database-sensitive for WIP purposes; otherwise it is not).

## Explicit non-goals

- No change to the hard Aurinko dependency (`approvals.ts:686-693`) — E02.
- No bookable-slot suggestion engine ("next free slot is…") beyond what the voice tool already needs to say "taken" — full alternatives engine is E02.
- No calendar-page redesign; only the approval card + existing dialogs gain the warning.
- No changes to reminder/no-show machinery.

## Dependencies

P0-003 (the service — **done 2026-08-06**, PR #10). Decisions D-015/D-016: approved.

## Entry gates (recorded by the Organizer at P0-003 close, 2026-08-06)

Distilled from the P0-003 completion record and Cursor review. The Builder addresses each inside this ticket's scope; none is optional:

1. **Verify** whether Aurinko event `dateTime` values always include a UTC offset or `Z` suffix (P0-003 known limitation: offsetless values currently parse in server-local time).
2. **Normalize** offsetless provider datetimes using their declared timezone **before** they affect any booking decision.
3. Never interpret offsetless provider datetimes using server-local time.
4. Consider cancellation/`AbortController` support for timed-out calendar requests (today the request is abandoned, not cancelled).
5. Add a missing-shop availability test (shop id that doesn't exist → defined, safe result).
6. Make the 90-minute missing-duration fallback **visible** — via logging or conflict metadata — wherever it influences a result.
7. Evaluate the composite index `appointments(shop_id, scheduled_at)` (P0-003 recommendation; if adopted, this ticket becomes database-sensitive for WIP purposes per scope item 6).
8. Ensure every newly created appointment stores a reliable `ends_at` (today only reschedule/blockTime set it; `executeBookAppointment` does not).
9. Wire the central service into **every** path: booking, rescheduling, quote-acceptance, voice, owner-drag, and block-time.
10. Preserve automatic hard-block behavior (D-015) and explicit, authorized HITL overrides (D-016).
11. Record conflict and override audit evidence where required (`ConflictOverride` who/when/which, on the decision log / action payload).
12. Keep Gradia's internal calendar authoritative and external calendar sync optional/advisory (D-013/D-014).

## Expected modules affected

`approvals.ts` (booking/reschedule executors), `vapi-tools.ts` (proposeBooking response), `actions/quote-response.ts`, `actions/jobs.ts` (reschedule/blockTime), agent-runtime staging paths for booking, ApprovalCard component + `strings.ts`, possibly one migration (index).

## Database impact

Reads via the service. Override records ride existing structures (`action_decisions` / `pending_actions.payload`) — no new table. Optional index migration per P0-003 findings.

## Migration impact

At most one additive index migration.

## API impact

Vapi tool response shape for `propose_booking` gains a conflict outcome (backward-compatible — Vapi consumes text/JSON results). No public API changes.

## UI impact

ApprovalCard conflict warning + override confirm; blockTime/drag dialogs gain a warn-confirm. All states: loading (check in flight at stage time is server-side; card renders with data), empty (no conflict → no warning), error (check unavailable → card says availability unverified — never fabricate "no conflicts"), success. Mobile: warning must be visible pre-fold on the card.

## Permission impact

Only the owner (existing approval permission model) can override. Autonomous paths can never override (enforced in code, not prompt — D-012).

## Tenant-isolation impact

Service already scoped; executors pass `claimed.shop_id`. Add tenant test on the execution-time check.

## Security impact

None new. Override is an audited owner action.

## Idempotency requirements

Re-check at execution is idempotent; rollback-to-pending on refusal must not duplicate the card (existing atomic-claim semantics preserved).

## Observability requirements

Log line per refusal/override (`[availability]` prefix, shop id, action id, conflict kinds). These feed P0-012's alerting later; no new alert channel here.

## Analytics requirements

`booking_conflict_detected`, `booking_conflict_overridden`, `booking_conflict_blocked_automatic` (internal telemetry naming per 14 — not owner-facing metrics).

## Feature flag

`FEATURES.conflictEnforcement` — staged rollout: flag off = P0-003 service dormant (current behavior); flag on = checks live everywhere. Ship on in dev/staging, flip in prod after manual acceptance. Remove the flag in a cleanup ticket once stable (flags gate risk, not permanent config).

## Automated tests

- **Unit:** each call site stages/attaches conflict info; executor refusal in `automatic` context; override-required in `hitl` context; override recorded with who/when/what.
- **Integration (DB tier):** two overlapping `book_appointment` approvals — approving the second without override fails and rolls back to pending; with override succeeds and records it. Autonomous execution of a conflicting booking refuses.
- **Failure-path:** availability service degraded (`calendar: unchecked`) → card shows "unverified", HITL may proceed, automatic path policy: proceed on Gradia-data-only result (calendar advisory), refuse only on real conflicts. Locked in a test.
- **Tenant-isolation:** conflict check never crosses shops at an executor call site.
- **Idempotency replay:** re-claiming a rolled-back conflicting action doesn't duplicate cards.
- Extend the locking tests around ALWAYS_HITL — never weaken (D-012).

## Manual acceptance procedure

1. Seed a booking 10:00–12:00. Via voice (or simulated tool call), propose 11:00 → assistant response indicates the slot is taken; no silent conflicting stage.
2. Stage a conflicting booking via quote-accept; open `/approvals` → card shows the conflict warning with the named existing appointment.
3. Approve without override → refused with clear message; card stays pending. Approve with "Approve anyway" → booked; decision log shows the override.
4. Enable autopilot on a test agent (Package 2 shop) staging a conflicting booking → auto-execution refuses; card remains pending with conflict noted.
5. Drag-reschedule onto a busy slot → warn-confirm dialog; cancel leaves everything unchanged.
6. blockTime over an existing appointment → warn-confirm.
7. Flip `conflictEnforcement` off → all paths behave exactly as before (proves reversibility).

## Failure cases

- Availability check times out at execution → HITL: proceed with "unverified" recorded; automatic: proceed only if Gradia-data check succeeded and is clean (calendar advisory), else refuse. Exact matrix locked by tests.
- Race: slot taken between owner viewing card and approving → execution-time re-check catches it; owner sees refreshed conflict on the returned-to-pending card.
- Vapi retries a tool call → existing staging dedupe unaffected; verify no double-stage.

## Rollback strategy

Flip `FEATURES.conflictEnforcement` to false and redeploy (gate, don't delete). Index migration (if any) is additive and stays.

## Definition of done

All of `../12-definition-of-done.md` plus: every listed path demonstrably checks (manual steps 1–6 evidenced); D-015/D-016 semantics locked by tests; flag-off restores prior behavior; no weakened tests; analytics events emitting; BUILD_REFERENCE conventions honored on the card (icon+text status, strings in `strings.ts`).

## Review-fix addendum (Builder, 2026-08-07)

Two founder-directed review findings addressed on `fix/p0-004-conflict-enforcement` (after `d43ce16`):

1. **Operational rollout flag.** `FEATURES.conflictEnforcement` is no longer a static `true`: it is a getter over `NEXT_PUBLIC_GRADIA_CONFLICT_ENFORCEMENT` (parser `readConflictEnforcementEnv` in `features.ts`, documented in `.env.example`). Default **OFF** when unset; only the exact value `"true"` enables; `false`/malformed/unknown disable. Preview and Production can differ in Vercel (expected: Preview `true`, Production `false` until rollout). NEXT_PUBLIC_* values are build-time-inlined — changing the Vercel variable takes effect on the next deployment. Rollback strategy above now reads: unset the variable (or set `false`) and redeploy.
2. **Internal availability failures fail closed (founder policy).** Any Gradia-owned failure inside the check (shop lookup failure/not-found, appointments query failure, row-capped fetch, invalid range) now refuses execution for **both** automatic and HITL contexts — no booking, no override offered, card/action stays pending and retryable — recorded as a structured verification failure (`AvailabilitySummary.failure = { kind: "internal", code }`, codes from `AvailabilityFailureCode`). This is distinct from a normal conflict AND from external-calendar degradation, which stays advisory (`calendar: "unchecked"` + reason on a completed check). Owner-direct paths (drag-reschedule, block-time) refuse the same way; an override reason never bypasses a verification failure. The d43ce16 audit gating (override/availability audit only after appointment persistence) is preserved.

## Merge & review record (docs-close session, 2026-08-11)

**Merged:** PR #12 → `main` as `3b6d044`, 2026-08-11 (branch `fix/p0-004-conflict-enforcement`: `5a3376e` implementation → `d43ce16` Cursor review fix → `c0b66b1` founder review fixes). **CI:** `ci / checks` (1m39s) and `ci-integration / integration` (2m31s) green on the PR. **Review evidence:** no formal PR review verdict was filed on GitHub; the review trail is the two addressed rounds — `d43ce16` (co-authored by Cursor: D-016 override/availability audit gated on appointment persistence) and `c0b66b1` (founder-directed: env-controlled rollout flag + internal-failure fail-closed policy, detailed in the review-fix addendum above). The founder merged the PR.

Verified at close:

- **Every listed path checks:** book/reschedule executors (authoritative execution-time re-check, self-exclusion on reschedule), voice `proposeBooking` (D-015 refusal at staging), quote accept + owner-agent + MCP staging (advisory snapshot on the card), owner drag-reschedule and block-time (warn-confirm + recorded override, fail-closed on verification failure), autopilot `maybeAutoExecute` (context `automatic` → hard block, defense-in-depth behind ALWAYS_HITL).
- **D-015/D-016 locked by tests:** automatic hard-blocks and ignores override metadata; HITL requires a well-formed, approver-bound, conflict-covering override; override execution leaves a decision-log row. Internal availability failures fail closed for BOTH contexts (founder policy, `c0b66b1`); external-calendar degradation stays advisory. 93 deterministic tests across the three P0-004 suites + 6 DB-integration cases.
- **Rollout state:** `NEXT_PUBLIC_GRADIA_CONFLICT_ENFORCEMENT` unset in Production → enforcement fully dormant (dormancy test-locked); expected Preview `true` / Production `false` until acceptance. Changing the Vercel variable requires a redeploy (build-time inlining).
- **Migration:** one, additive + idempotent — `20260806120000_appointments_shop_scheduled_idx.sql` (composite `appointments(shop_id, scheduled_at)`, the index carried from P0-003 gate 7).
- **Manual acceptance (steps 1–7): NOT yet executed** — assigned to the **founder**, to run on a Preview deployment with the flag `true`; the production flag flip is gated on that run and gets the formal release record per `../releases/README.md` §Standing rules.

**Follow-up carried to backlog:** P0-004A — atomicity/concurrency of `executeBookAppointment` (lead + calendar event can land before a failed appointment insert; path still reports "executed"; check-then-insert race between re-check and insert). Pre-existing gap, out of P0-004 scope by review agreement.

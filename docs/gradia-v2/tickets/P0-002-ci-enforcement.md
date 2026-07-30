# P0-002 — CI typecheck, lint, build and integration enforcement

- **Ticket ID:** P0-002
- **Epic:** E00 — Stabilization
- **Status:** **done** (2026-07-30 — merged to `main` in PR #9, commit `7e3d530`; Cursor Reviewer verdict APPROVE, no BLOCKER or HIGH findings; completion record below)
- **Priority:** Critical (`main` = production and CI currently cannot stop a broken build)

## Objective

Make CI able to fail for the reasons production can fail: add typecheck, lint, and production build to the gating workflow, and un-quarantine the DB-backed integration tier that has been `continue-on-error` since 2026-06-18 (red since 2026-06-04). Audit doc 12 items 2 and 5; audit doc 03 "CI checks: PARTIAL — npm test only".

## User outcome

No owner ever loads a production deploy that a typecheck or build would have caught. Every future P0 ticket lands against CI that actually gates.

## Current code references

- `ci.yml` — runs `npm test` only (audit doc 12 item 2: "add `tsc --noEmit`, `npm run lint`, `next build` steps (build needs placeholder envs)").
- `ci-integration.yml` — quarantined `continue-on-error` since 2026-06-18, red since 2026-06-04; Supabase CLI now pinned at 2.98.2 (audit doc 12 item 5; audit doc 03 "Integration (DB) tests: BROKEN/quarantined").
- Test baseline: 52 files / 430 passing deterministic tests (audit doc 03).
- Audit docs: `10-production-readiness.md` ("CI cannot stop a type-broken build from reaching production"), `07-ai-architecture-audit.md` §Evals.

## Exact scope

1. Extend the gating CI workflow with three blocking steps: `tsc --noEmit`, `npm run lint`, `next build` (with documented placeholder env vars sufficient for a build — no real secrets in CI).
2. Verify the integration workflow goes green on the pinned Supabase CLI; then remove `continue-on-error` so it blocks. If it cannot be made green within the ticket, that is a **blocked** outcome reported to the Organizer with the failing evidence — not a silently retained quarantine.
3. Add the repo-hygiene secret grep from P0-001 as a CI step if P0-001 delegated it here (check that ticket's appendix).
4. Document required CI placeholder envs in `.env.example` comments or a CI section of `docs/env-setup.md`.
5. Confirm branch protection expectations: the workflow(s) that must pass before merge to `main`, recorded in the completion report (actually flipping GitHub branch-protection settings is a founder/dashboard step — list it in manual acceptance).

## Explicit non-goals

- No new tests are written (beyond trivial fixes needed to make existing suites pass under the new steps).
- No live-model eval gating (Tier 2/3) — that is roadmap item "eval gating" (audit doc 12 item 9), a separate ticket pending decision Q-06 (eval budget/cadence).
- No E2E suite (P10).
- No fixing of lint/type errors beyond what the new gates surface; if the volume is large, report and split.

## Dependencies

None (P0-001 is sequenced first by sprint policy, but there is no technical dependency).

## Expected modules affected

`.github/workflows/ci.yml`, `.github/workflows/ci-integration.yml`, possibly `.env.example` / `docs/env-setup.md`, and whatever small source fixes the new gates surface.

## Database impact

None. (The integration tier runs against a disposable local Supabase, not prod.)

## Migration impact

None — but the integration tier becoming blocking is what will validate future migrations (audit doc 03: "Migration validation: only via the quarantined integration tier").

## API impact

None.

## UI impact

None.

## Permission impact

None in-app. CI secrets handling: placeholder envs only; no production secrets enter workflow files.

## Tenant-isolation impact

Indirect but real: the integration tier is the only DB-backed proof of the approval engine; un-quarantining it restores the regression net for tenancy-relevant behavior.

## Security impact

CI must not echo env values; placeholder values must be obviously fake. The secret-grep step (if adopted here) becomes the standing leak regression check.

## Idempotency requirements

CI steps must be re-runnable; the integration tier must reset its database per run (verify existing behavior, don't rebuild it).

## Observability requirements

Failed CI is the observability. Ensure failure output names the failing step plainly (no swallowed exit codes, no `|| true`).

## Analytics requirements

None.

## Feature flag

None — fix, not feature. CI gating has no user-facing partial state.

## Automated tests

This ticket IS the test infrastructure. Verification is meta:

- **Failure-path:** on a scratch branch, introduce (a) a deliberate type error, (b) a lint error, (c) a build-breaking import — each must fail CI; then revert.
- **Integration:** one PR showing the integration workflow green AND blocking (no `continue-on-error` in the final workflow file).

## Manual acceptance procedure

1. Open a scratch PR with a deliberate type error → CI red on the typecheck step. Revert.
2. Repeat for a lint violation and a broken `next build` → red on the respective steps. Revert.
3. Open a clean PR → all steps green, including the integration tier, with `continue-on-error` absent from the workflow file.
4. `git log` of the workflow files shows no step weakened or skipped to obtain green (Reviewer checks — "do not weaken tests to obtain a green result").
5. Founder (dashboard): set branch protection on `main` to require the gating workflow(s); screenshot or settings description recorded in the completion report.

## Failure cases

- **Integration tier cannot go green** (real drift beyond the CLI pin) → stop, report evidence, mark that sub-scope blocked; do NOT ship a re-quarantine as "done".
- **`next build` needs env vars that don't exist as placeholders** → add documented fakes; if a code path hard-crashes the build on a fake value, report it (that's a real prod footgun) rather than papering over it.
- **Existing lint/type debt too large to fix in-scope** → report the count, propose a split; do not disable rules wholesale.

## Rollback strategy

Revert the workflow-file commits. No schema, no runtime surface. (Rolling back re-opens the "broken build can reach prod" hole, so a rollback requires an Organizer-recorded reason.)

## Definition of done

All of `../12-definition-of-done.md` plus: the three new steps demonstrably fail on seeded errors (evidence links in the completion report); integration tier blocking and green; placeholder envs documented; branch-protection step handed to the founder with exact settings; no test or lint rule weakened to get there.

---

## Completion record (Organizer, 2026-07-30)

Merged to `main` (= production) in **PR #9**, commit `7e3d530` ("fix: enforce CI quality gates"), with a green CI run on the merged workflows. Independently reviewed and approved: **Cursor Reviewer verdict APPROVE — no BLOCKER or HIGH findings.**

### What is now blocking in CI

The gating workflow (`ci`, job `checks`) runs, in order, all blocking:

1. **Secret hygiene** — the P0-001 repo-hygiene grep is a standing CI step (a hit fails the build; CI output does not republish the matched value).
2. **TypeScript typecheck** — `tsc --noEmit`.
3. **Lint** — `npm run lint`.
4. **Deterministic tests** — `npm test` (Tier 1).
5. **Production build** — `next build` with documented placeholder envs (`docs/env-setup.md` §CI); no real secrets.

The integration workflow (`ci-integration`, job `integration`) is **un-quarantined and blocking**:

- Runs the DB-backed integration tests against a **disposable local Supabase stack** started inside the job (`supabase start`), applying every migration.
- **Supabase CLI pinned to 2.98.2.**
- **No production secrets and no GitHub repository secrets required** — integration credentials are generated inside the CI job (`supabase status -o json`).
- Teardown (`supabase stop --no-backup`) runs under **`if: always()`**.
- `continue-on-error` is absent from the workflow file (appears only in a comment citing the §5 rule that forbids it).

### Branch protection (founder-confirmed)

GitHub branch protection on `main` requires both status checks:

- `ci / checks`
- `ci-integration / integration`

### Downstream effect

The global review gate is satisfied: tickets with status `ready-after-P0-002` may now enter review, and **P0-003 may enter implementation** (it was the one ticket whose *implementation* was gated on P0-002). P0-003 is queued as the next active implementation ticket — see `../program/current-sprint.md`; implementation has **not** started.

### Remaining limitations (recorded, not blockers)

- Live-provider and model evaluations (Tier 2/3) remain **outside** standard CI, pending decision **Q-06** (eval budget/cadence) — see `../09-testing-strategy.md` §3 and risk R-12.
- Supabase CLI upgrades off the 2.98.2 pin require deliberate re-verification of the integration tier (an upgrade is a change to test infrastructure, not a routine bump).
- GitHub Actions runtime/action-version upgrades may be handled in a later maintenance ticket.
- The integration test code currently relies on the workflow's fail-loud environment guard (rather than its own env validation) — acceptable for now; note for any future refactor of the integration suite.
- Completion/release evidence should reference the successful PR (#9) and its CI run.

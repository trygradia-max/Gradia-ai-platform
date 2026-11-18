# Onboarding baseline UI: resume handoff

Branch `claude/onboarding-baseline-ui`, based on `origin/main` `536bb6b` (PR #151 merged).
Scope: customer experience only for the already-merged onboarding-baseline backend. No new
persistence, no second onboarding system, no billing/provider/model/deploy/production change.

If this session is interrupted, read this file first, then `git log --oneline origin/main..HEAD`.

## Audit: what already exists on main

| Area | State |
| --- | --- |
| Migration `20261104120000_onboarding_baseline.sql` | Done. Immutable `baseline.v1` catalog, immutable revisions, forward-only pointer, **server-side owner/manager draft with compare-and-set `draft_version`**, append-only measurements (service role only). Authority derived in the database from live membership. |
| `src/lib/onboarding-baseline/{catalog,validate,report,dto,service}.ts` | Done and unit-tested (`eval/onboarding-baseline.test.ts`, integration `eval/integration/onboarding-baseline.int.test.ts`). Report DTO carries evidence classes, period, formula/definition versions, `unknown` vs `not_measured`. |
| `src/app/actions/onboarding-baseline.ts` | Done but **takes `shopId` from the caller** (an address; the database authorizes). No UI consumes it. No tests at the action seam. |
| Onboarding wizard (`/onboarding`) | 3 steps (business → number → help). **No Starting point step.** `onboarding_step` is persisted as 1 \| 2 \| 3. |
| Dashboard / Agent OS / Settings | **No link** to the baseline anywhere. |
| UI for the quiz and the report | **None.** |

Persistence finding: the backend persists drafts server-side, so progress is resumable from the server.
No local draft store is needed or added; "saved" is only ever shown after the server confirms it.

## Gap list (this PR)

1. Session-derived action seam: shop and actor come from the session, never from the client; callers cannot
   name a shop. Owner first, then a manager holding the explicit `baseline.draft` grant. Reporting period is
   computed on the server. Tests at the seam.
2. Pure UI model: question copy (plain operator language), form state to/from catalog answers, grouping into
   a few short sections, progress, plain validation messages, report presentation (labels, value/period
   formatting). No fabricated numbers; `unknown` stays `unknown`.
3. Quiz component: accessible, mobile-first, resumable from the server draft, explicit "Not sure" per question,
   validation, conflict/error/permission/already-completed/revision states.
4. Starting-point report component: four sections, per-metric evidence label and period, measured vs owner
   estimate, baseline date/version, no ROI/causal claims, "Not measured yet" for missing.
5. Canonical route `/starting-point` (inside the dashboard group) for the report and revisions.
6. Wizard: insert the Starting point step after the business profile (stable persisted step ids; legacy
   1/2/3 values keep their meaning, 4 = Starting point, display order business → starting point → number → help).
7. Links: Home status card, Settings section, Agents home notice, wizard. No sidebar item (final IA is locked).
8. Tests (navigation/link wiring, a11y semantics via renderToStaticMarkup and jsdom, validation, unknown
   handling, authority at the seam, resume, report evidence labels), docs, AI work log, PR.

## Milestones and checkpoints

- [x] M0 audit + this file
- [x] M1 session-derived actions + seam tests (`src/app/actions/onboarding-baseline.ts`, `period.ts`, `eval/onboarding-baseline-actions.test.ts`)
- [x] M2 UI model + copy + tests (`form-model.ts`, `report-model.ts`, `format.ts`, `copy.ts`, `eval/onboarding-baseline-ui-model.test.ts`)
- [x] M3 quiz + report + container components + tests (`src/components/gradia/starting-point/*`, `eval/starting-point-*.test.tsx`)
- [x] M4 route `/starting-point`, wizard step, Home/Settings/Agents links
- [x] M5 checks, work log, PR

## What shipped

- **Seam.** `getBaselineStartingPoint()`, `saveBaselineDraft`, `submitBaselineAssessment`, `getBaselineComparison` no longer take a
  shop id, role, period or evidence (strict schemas reject them). Workspace = owner's active shop, else the one workspace where the
  caller is an active manager holding `baseline.draft`. Reporting period is computed server-side: 90 days ending yesterday (UTC).
  The database remains the authority (owner submits, manager drafts, staff/revoked/anonymous/cross-shop refused).
- **Additive DTO field.** The `ready` DTO now carries the revision's `answers` so an owner can start an update from them. No
  migration, no change to the database contract.
- **Resume.** Server draft with compare-and-set `draft_version`. Nothing is stored in the browser; "Saved" is shown only after the
  server confirms. Conflict asks for a reload and never overwrites.
- **Wizard.** Persisted step ids stay stable (1 business, 2 number, 3 help); 4 = Starting point; display order is
  `WIZARD_STEP_ORDER = [1, 4, 2, 3]`. `saveShop` now persists 4 after the business profile. Shops already past that point are unaffected.
- **Entry points.** Status card on Home and in Settings (`#starting-point`), notice on the Agents home while not started, wizard step.
  No sidebar item (final IA is locked). One route: `/starting-point` (`?revise=1` opens the update flow).

## Limitations / next dependency

- A manager of several workspaces reaches the first one with the `baseline.draft` grant (no workspace selector yet).
- Evidence attachment (`p_evidence`) has no UI: connected/observed measurements are service-written, so every figure is labelled
  Owner estimate until that pipeline exists. The day-30 comparison UI is not built (the action exists and is session-derived).
- The period is fixed at 90 days; an owner cannot pick another window.
- Pending: signed-in desktop/mobile acceptance on a real shop with real owner/manager/staff accounts (not done here), 200%-zoom and
  screen-reader pass by a human. Layout was checked in a headless browser at 390px and 1280px (no horizontal overflow, 44px tap rows).
- Evals are not affected (no prompt, model or recipe change).

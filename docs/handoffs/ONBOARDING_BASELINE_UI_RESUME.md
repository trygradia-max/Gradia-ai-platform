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
- [ ] M2 UI model + copy + tests
- [ ] M3 quiz + report components + tests
- [ ] M4 route, wizard step, links
- [ ] M5 full checks, docs, work log, PR

## Environment notes

- Worktree had no `node_modules`; `npm ci` was run locally (981 packages). Not committed.
- Local integration needs a disposable Supabase stack; see earlier handoffs for the recipe. No shared or production database is touched.

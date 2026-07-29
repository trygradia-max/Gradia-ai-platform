# 12 — Definition of Done

_Created 2026-07-25 by the Organizer. Binding for every implementation ticket. The Builder self-certifies each item in the completion report; the Cursor Reviewer independently verifies. A ticket is **not done** while any REQUIRED item is unmet — "mostly done" is not a status._

## A. Scope & invariants

- [ ] Change stays inside the ticket's **exact scope**; explicit non-goals untouched; no opportunistic refactors, no unrelated packages.
- [ ] All preserved invariants hold: workflows-over-loops, guardrails in code not prompts, planner→runtime split (D-009), one approval engine / one send path (D-011), money+calendar ALWAYS_HITL (D-012/D-021), zero founder-touch per signup, we/us persona untouched.
- [ ] No founder-level decision was made silently; anything unresolved went to `program/decision-queue.md` and the ticket was marked blocked instead of guessed.

## B. Build & tests (per `09-testing-strategy.md`)

- [ ] `tsc --noEmit` clean · `npm run lint` clean · `npm test` green · `next build` succeeds (production build, not dev).
- [ ] Every applicable test class added: unit / integration / tenant-isolation / permission / idempotency-replay / failure-path / migration / provider-contract / evals. Each "N/A" justified in the completion report.
- [ ] **No test weakened, skipped, or deleted** to reach green; new invariants introduced by this ticket ship with their own locking tests.
- [ ] Prompt/model/recipe changes: affected Tier-2 eval suites run, results pasted in the report.

## C. Data & tenancy

- [ ] Migrations (if any): additive-preferred, idempotent (`IF NOT EXISTS`/`ON CONFLICT`), commented, numbered; re-run twice locally without error; rollback note written.
- [ ] RLS reviewed for **every** touched table; new tables ship with tenant policies in the same migration; ledger tables never owner-writable (D-024).
- [ ] Tenant scoping explicit on every query — RLS-client paths still carry `.eq("shop_id")` for defense-in-depth; service-role paths use the scoping helper (post-P0-011) or a justified explicit filter.
- [ ] External events idempotent via **provider event identifiers enforced by DB uniques** (D-023) — never check-then-insert.
- [ ] Financial records immutable: corrections are offsetting rows, never UPDATE/DELETE on ledgers.
- [ ] Durable invariants use database constraints, not code checks alone.

## D. Security

- [ ] All external input validated (zod at the boundary); no unauthenticated routes/actions added; rate limiting considered for public surfaces.
- [ ] No secrets in source, logs, tests, fixtures, or docs; new stored credentials use `crypto.ts` AES-256-GCM; new env vars documented in `.env.example`.
- [ ] Risky AI actions route through the existing approval engine; no new autopilot-eligible action types without Organizer sign-off.
- [ ] Business/compliance rules live in code (never prompts) and are test-locked.

## E. Reliability & observability

- [ ] No silent failure paths added: no unjustified `.catch(() => null)`, no error suppression; failures surface, roll back, or alert.
- [ ] Structured, actionable failure logging (`[module]` prefix, shop_id, provider refs); Sentry captures where appropriate.
- [ ] Fail-closed behavior preserved for credits, entitlements, webhooks, crons.
- [ ] Feature flag defined and wired when the ticket spec requires one (incomplete or high-risk functionality); flag default matches the spec.

## F. UI (every user-facing change)

- [ ] Loading state (skeletons, not spinners, for page loads) · written empty state in `strings.ts` · error state · success state.
- [ ] Mobile behavior verified (responsive collapse) · accessibility (labels, focus, contrast, `prefers-reduced-motion`) · permission behavior (what a non-entitled/free shop sees).
- [ ] One clear primary action per screen; **no dead controls**; integration-failure behavior designed (what the owner sees when the vendor is down).
- [ ] Design system honored: semantic tokens only, one accent, Geist/`.font-data`, no fabricated metrics or percentage confidence (D-025; `BUILD_REFERENCE.md`).

## G. Completion report (required to close)

The Builder returns: summary · files changed · migrations added · tests added · commands executed + results · manual acceptance steps (executed, with outcomes) · security & tenancy review · known limitations · rollback procedure · follow-up tickets discovered · confirmation the work stayed in scope.

- [ ] **Manual acceptance: every step accounted for (tightened 2026-07-27).** Each step in the ticket's manual acceptance procedure is either (a) executed by the Builder with its outcome recorded, or (b) explicitly assigned to a **named human** (e.g. "founder: rotate password in Supabase dashboard") with that assignment recorded in the report and the ticket held out of **done** until the human confirms. A report in which zero steps were executed and none were assigned is a **hard fail** — "where possible" is not a compliance escape.
- [ ] **Documentation updated (the pipeline's final step).** Every planning/ops doc affected by this ticket is amended in the same change: capability statuses (`04` + `program/capability-status.md`), ticket status lines, `program/` boards, runbooks or vendor docs the change touches, and release records where `13-release-strategy.md` requires one. "Docs to follow" is not a state.

## H. Review

- [ ] Cursor Reviewer verified the diff against the ticket spec and this checklist and signed off in the ticket file.
- [ ] Ticket status updated in `tickets/` and `program/` (current-sprint / work-in-progress) by the Organizer.

**Hard fails (automatic not-done):** required tests failing · production build failing · tenant isolation uncertain · acceptance criteria unmet · **zero manual-acceptance steps executed with none assigned to a named human** · affected planning docs not updated · scope exceeded · a locked test weakened.

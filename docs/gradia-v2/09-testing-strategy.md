# 09 — Testing Strategy

_Created 2026-07-25 by the Organizer. Grounded in audit docs 03 (§Testing) and 07 (§Evals). Defines the test tiers, CI gates, per-ticket test requirements, and the evidence needed to move a capability's status._

## 1. The tiers (what exists today)

| Tier | What | State (audited 2026-07-20) |
|---|---|---|
| **Tier 1 — deterministic** | ~52 suites / 430 passing: safety-floor locking tests (ALWAYS_HITL in autonomous mode, Package-2 gating, persona lock), source-scans (owner-agent has no send tool; BI tools read-only), webhook forgery/tamper/replay for all four providers, send-policy, credits, TCPA, A2P | ✅ CI-gated on every push — the strongest asset |
| **Tier 2 — live-model evals** | 7 golden suites (`npm run eval`): extraction, classification, BI, owner-agent, routing, recovery-extraction, review-request | ⚠️ Exists, **not CI-gated** — discipline only |
| **Tier 3 — LLM-as-judge** | Sonnet judge for tone, used sparingly | ⚠️ On-demand only |
| **Integration (real Postgres)** | DB-backed approval-engine tests | ✅ **Un-quarantined and blocking since 2026-07-30 (P0-002, PR #9)** — green on disposable local Supabase, CLI pinned 2.98.2; was quarantined `continue-on-error` 2026-06-18 → 2026-07-30 |
| **E2E** | — | ❌ None (Playwright suite is P10 scope) |
| **CI itself** | `npm test` only *(pre-P0-002)* | ✅ **Since 2026-07-30 (P0-002):** secret hygiene + typecheck + lint + deterministic tests + production build, all blocking (see §2) |

## 2. CI gate (P0-002 — **landed 2026-07-30**)

Every push/PR to `main` must pass, in order: secret-hygiene grep → `tsc --noEmit` → `npm run lint` → `npm test` (Tier 1) → `next build` (placeholder envs) → integration tier **un-quarantined and blocking**. A deliberate type error, lint error, broken build, or red integration run fails CI. Landed as **P0-002** (merged PR #9, 2026-07-30; Cursor Reviewer APPROVE, no BLOCKER/HIGH findings) — the precondition for any other ticket entering review is satisfied.

Implementation facts of record (full completion record in `tickets/P0-002-ci-enforcement.md`):

- GitHub branch protection on `main` requires **`ci / checks`** and **`ci-integration / integration`**.
- The integration job runs against a **disposable local Supabase stack** started in-job; **Supabase CLI pinned to 2.98.2** — upgrading the pin requires deliberate re-verification of the tier, never a routine bump.
- **No production secrets and no GitHub repository secrets** are required; integration credentials are generated inside the CI job. Teardown runs under `if: always()`.
- The integration test code currently relies on the workflow's fail-loud environment guard for its env preconditions — keep that guard intact until the suite validates its own env.
- Known gap (not a regression): Tier 2/3 live-model evals remain outside this gate — see §3 and decision **Q-06**.

## 3. Eval gating (locked principle #6)

"Evals gate every model/prompt/recipe change" — currently true only for Tier 1. Target:

- **Path-filter rule:** PRs touching prompt files, model ids, or recipe/planner modules require a green Tier-2 run for the affected suites before merge.
- **Scheduled run:** nightly (or agreed cadence) full `npm run eval` with failure notification to the founder channel (rides on P0-012 alert delivery).
- Cadence/budget is an open founder decision — `program/decision-queue.md` **Q-06** (cross-reference corrected 2026-07-27; Q-08 is the alert destination). Until decided, the interim rule binds Builders: **any prompt/model/recipe change runs the affected Tier-2 suites locally and pastes results in the completion report.**

## 4. Required test classes per ticket

Each ticket spec lists which classes apply; the Builder adds them, the Cursor Reviewer verifies. "N/A" must be justified in the completion report, not silently skipped.

| Class | Required when | Notes |
|---|---|---|
| Unit | Always | Pure logic, drafters' deterministic parts, helpers |
| Integration (DB) | Any ticket touching migrations, RLS, approvals, ledgers | Runs in the un-quarantined tier |
| Tenant-isolation | Any service-role path or RLS change | Prove a second shop's rows are unreachable; assert the `forShop`/scoping mechanism once P0-011 lands |
| Permission | Any auth/role/entitlement change | Incl. Package-2 gating, `checkFeatureAccess` 402s |
| Idempotency replay | Any webhook/metering/import/payment path | Replay the same provider event twice → exactly one row/card/charge (D-023) |
| Failure-path | Any external call or multi-step mutation | Provider 500/timeout, partial failure, rollback-to-pending behavior; no new silent `.catch(() => null)` |
| Migration | Any migration | Idempotent re-run; additive verified; spot-check columns (GO_LIVE_CHECKLIST pattern) |
| Provider contract | New/changed vendor endpoint use | At minimum recorded-fixture tests; live verification items go to `vendors/*` "requires verification" |
| AI evals | Any prompt/model/recipe change | Per §3 |
| E2E | P10 onward | Playwright smoke: onboarding → lead → approve → book on a seeded shop |

## 5. Locked tests — extend, never weaken

The Tier-1 locking tests are the enforcement mechanism for the architecture principles (guardrails in code, ALWAYS_HITL, one send path, persona, webhook security). Binding rules:

1. A Builder may **add** assertions/cases to a locking test; may never delete, skip, loosen, or broaden its tolerances to get green.
2. If a locked test fails, the change is wrong — not the test. The only exception is a founder-approved decision recorded in `11-decision-log.md` first.
3. New invariants introduced by a ticket (conflict hard-block for automation D-015, idempotency uniques D-023, ledger immutability D-024) ship **with their own locking tests** in the same PR.
4. `continue-on-error` on any test job is forbidden after P0-002; quarantining a suite requires an entry in `program/blocked.md` with an owner and an exit date.

## 6. Evidence for capability status transitions

Statuses per `04-capability-map.md`: not planned → planned → designed → building → **internal → pilot → public** → deprecated. A table or page existing is never evidence. Minimum evidence to advance:

| Transition | Required evidence |
|---|---|
| building → **internal** | All ticket DoDs met; Tier-1 + applicable classes green in CI; flag on for internal shops only |
| internal → **pilot** | Manual acceptance procedure executed on a seeded/test shop and recorded (GO_LIVE_CHECKLIST-style smoke); live provider round-trips verified where the capability touches a vendor (the audit's CANNOT_VERIFY items close here); idempotency replay demonstrated against the real webhook where applicable |
| pilot → **public** | ≥1 real shop through the flow without SEV incidents; analytics events firing (post-instrumentation); claims updated per D-028 (`WHAT_GRADIA_DOES.md` moves it to the claim list); Release Reviewer sign-off |
| any → **deprecated** | Flag off + written migration/comms note in `releases/` |

The audit's `CANNOT_VERIFY*` markers (A2P TrustHub SIDs, Housecall Pro endpoint shapes, Vapi/Aurinko live behavior) are standing pilot-gate blockers tracked in `vendors/*` and `program/blocked.md`.

## 7. Manual performance tools (PERF-001, 2026-09-02)

Not a CI gate — a repeatable way to put numbers on the five dashboard routes before and after a change.

- **Seed** (local stack only; refuses any non-loopback Supabase URL): `eval "$(supabase status -o env)"; SUPABASE_TEST_URL="$API_URL" SUPABASE_TEST_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" node scripts/perf-seed.mjs` → an owner + shop at the ticket's shape (≥ 500 customers, ≥ 200 appointments, ≥ 50 pending). `--clean` removes every perf-seed shop.
- **Server query log**: run the production build with `PERF_TIMING=1` (`next start`); every Supabase call through `lib/supabase/server.ts` logs `[perf] req=<id> n=<k> <METHOD> <table> <ms>ms` — method + table + duration only, never a query string. Off by default; never set in Production.
- **Sampler**: `PERF_COOKIE='<signed-in document.cookie>' node scripts/perf-timing.mjs --base http://localhost:3100 --samples 20 --server-log /tmp/next-perf.log` → p50/p75/p95 TTFB and full-response time per route, HTML size, and (from the log) queries per request, DB ms per request, and the query span. On a Vercel Preview drop `--server-log` and read TTFB only.
- **Interaction**: Approve is recorded with the DevTools performance trace (INP / interaction-to-next-paint) — a manual devtools recording, noted as such in the ticket.

Baselines and before/after tables live in the ticket that produced them (`tickets/PERF-001-…md` §Measurements). Any later ticket that touches a dashboard loader re-runs the sampler and records the delta in its close record.

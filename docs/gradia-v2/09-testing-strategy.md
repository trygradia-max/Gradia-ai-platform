# 09 — Testing Strategy

_Created 2026-07-25 by the Organizer. Grounded in audit docs 03 (§Testing) and 07 (§Evals). Defines the test tiers, CI gates, per-ticket test requirements, and the evidence needed to move a capability's status._

## 1. The tiers (what exists today)

| Tier | What | State (audited 2026-07-20) |
|---|---|---|
| **Tier 1 — deterministic** | ~52 suites / 430 passing: safety-floor locking tests (ALWAYS_HITL in autonomous mode, Package-2 gating, persona lock), source-scans (owner-agent has no send tool; BI tools read-only), webhook forgery/tamper/replay for all four providers, send-policy, credits, TCPA, A2P | ✅ CI-gated on every push — the strongest asset |
| **Tier 2 — live-model evals** | 7 golden suites (`npm run eval`): extraction, classification, BI, owner-agent, routing, recovery-extraction, review-request | ⚠️ Exists, **not CI-gated** — discipline only |
| **Tier 3 — LLM-as-judge** | Sonnet judge for tone, used sparingly | ⚠️ On-demand only |
| **Integration (real Postgres)** | DB-backed approval-engine tests | ❌ **Quarantined** `continue-on-error` since 2026-06-18, red since 06-04 (CLI now pinned) |
| **E2E** | — | ❌ None (Playwright suite is P10 scope) |
| **CI itself** | `npm test` only | ❌ No typecheck, no lint, no build — a type-broken build can reach main = production |

## 2. Target CI gate (P0-002)

Every push/PR to `main` must pass, in order: `tsc --noEmit` → `npm run lint` → `npm test` (Tier 1) → `next build` (placeholder envs) → integration tier **un-quarantined and blocking**. A deliberate type error, lint error, broken build, or red integration run fails CI. This lands as **P0-002** and is a precondition for any other ticket entering review (a reviewer needs a CI that can say no).

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

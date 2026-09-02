# E01-05 — Eval gating in CI: live-tier evals required on prompt-file change + nightly eval run with failure alerting

_Cut 2026-09-01 by the Organizer for autorun Batch 2 (`../program/autorun.md`). Specification only._

## Ticket ID
E01-05

## Epic
E01 — Organization, tenancy and backend foundation (phase P1)

## Status
**draft — DECISION-GATED on Q-06.** Autorun Batch 2, queue item 9 (last item on `auto/batch-2`). The autorun queue entry reads "(Q-06 both)" — i.e. it assumes the Organizer's recommendation (nightly run **and** on-prompt-change CI path filter). **Q-06 is not in the decision log** (it was not in the founder's 2026-09-01 batch line). Per autorun rule 5 the Builder must HARD STOP on reaching this item unless the founder has approved Q-06 → recorded as a D-number. **Founder action before Batch 2 reaches item 9:** approve Q-06 (recommendation: both) in writing; the Organizer records it. Risk class **standard** (CI + scripts). Founder acceptance **no**. Other binding decisions: locked principle #6 (evals gate every prompt/model change), D-029 (E01-04 seam), D-042 (alert destination for nightly failures).

## Priority
P1 — High. `.github/workflows/ci.yml:47-49` states the live tiers are out of CI "pending decision Q-06"; a drafter prompt regression ships on green CI today (audit doc 07). E01-04 just centralized the model layer — this ticket makes the eval gate mechanical.

## Objective
(1) A CI job that runs the relevant live Tier-2 eval suites when a PR touches any prompt file or `llm.ts`, using a CI-scoped Anthropic key with a per-run token budget, blocking merge on failure; (2) a nightly scheduled full `npm run eval` with results archived and failure alerts through the P0-012 seam (D-042); (3) the prompt-file manifest that both use, plus a source-scan test that any new inline system prompt is registered in the manifest.

## User outcome
Invisible to owners; the persona/voice they hear stays eval-locked. Founder-as-operator: a prompt regression fails the PR, not the customer; a provider-side drift shows up the next morning.

## Current code references
- CI: `.github/workflows/ci.yml` (typecheck `:41-42`, lint `:44-45`, deterministic tests `:50-51`, build `:58-59`; live tier explicitly excluded `:47-49`); `.github/workflows/ci-integration.yml` (Supabase-backed integration tier; `continue-on-error` forbidden per `09-testing-strategy.md` §5, comment `:21-31`).
- Scripts: `package.json:11-13` — `test`, `eval` (`EVAL_LIVE=1 vitest run --exclude '**/integration/**'`), `test:int`; no `typecheck` script (CI calls `npx tsc --noEmit`).
- Eval harness: `eval/README.md:7-48` (tiers + commands), `eval/_lib.ts:10-11` live gate, `:59` judge, `eval/_setup.ts` loads `.env.local`; suites `eval/bi|classification|extraction|owner-agent|owner-agent-routing|recovery-extraction|review-request.eval.test.ts`, `eval/draft-verifier.test.ts:86` own LIVE flag; golden cases `eval/cases/{extraction,sms,email}.json`; fixtures `eval/fixtures/recovery-threads.ts`.
- **Prompt files (no `src/lib/prompts/` dir — inlined per module):** `src/lib/persona.ts:12,17,22,26`; `src/lib/vapi-prompt.ts`; `sms-drafter.ts:45,138,234,279`; `email-drafter.ts:50,120,207`; `sms-classifier.ts:48`; `email-classifier.ts:56`; `bi-agent.ts:31,69`; `owner-agent.ts:92`; `agent-planner.ts:349`; `whisper.ts:74`; `ai-service.ts:46,58`; `review-request.ts:24`; `voice-provider.ts:108,153-216`. Plus `src/lib/llm.ts` (E01-04) and `eval/cases/**`.
- Alerts: `src/lib/alerts.ts` (P0-012) — destination per D-042 (founder Slack ops channel; SMS for SEV-0/1). Nightly failure = SEV-3 (informational) unless the persona suite fails (SEV-2).
- Budget context: `15-cost-and-margin-model.md`; `vendors/ai/anthropic.md`.

## Exact scope
1. **Prompt manifest:** `eval/prompt-manifest.json` (or `.ts`) listing every prompt-bearing file above + `src/lib/llm.ts` + `eval/cases/**` and, per file, the eval suites that cover it. Source-scan test: any `src/lib/**` file exporting/declaring a `SYSTEM`/`*_SYSTEM`/`SYSTEM_PROMPT`/`*_BLOCKS` prompt constant or calling `llm.*` with a system string must be in the manifest (fail closed on new prompts).
2. **CI path-filter job (`ci-evals`):** new workflow triggered on `pull_request` when changed paths intersect the manifest (use `dorny/paths-filter` or a small script step); runs only the suites mapped to the changed files (`vitest run <suites>` with `EVAL_LIVE=1`); **required check** (branch protection is a founder action — record it); per-run token budget enforced by a wrapper that aborts when a cost counter (from E01-04's `llm_calls`/gateway record in CI mode → in-memory) exceeds `EVAL_CI_BUDGET_USD` (default e.g. $3); the key is a **CI-scoped** `ANTHROPIC_API_KEY_CI` GitHub secret (founder creates it — platform-level, once) with fork PRs skipped (no secrets on forks → job reports "skipped: fork").
3. **Nightly:** `schedule` cron (e.g. 09:00 UTC) running the full `npm run eval` + `eval/draft-verifier` live section; results uploaded as an artifact (JSON summary + junit); on failure, a step posts through the P0-012 alert seam (an HTTP call to a small authenticated `/api/internal/ci-alert` route **or** directly to the ops webhook — Builder chooses the simpler that keeps the destination in one place: prefer calling the deployed alert route with `CRON_SECRET` bearer so D-042 routing applies). Budget cap likewise.
4. **Judge determinism hygiene:** judge model pinned via the E01-04 registry tier `judge`; suites report pass counts; flaky-threshold policy documented (a suite may declare `minPass` for judge-scored cases; deterministic-field cases are strict).
5. **`eval/README.md`** updated with the gate policy (what triggers, budget, how to run locally, how to add a prompt = add to manifest + suite); `09-testing-strategy.md` §evals; `.github/workflows/ci.yml:47-49` comment replaced with the pointer to `ci-evals.yml`.
6. Record in the ticket close: the founder actions (CI secret, branch protection) and their status.

## Explicit non-goals
- No new eval cases or suites (existing coverage; case gaps go to backlog).
- No prompt edits, no model changes.
- No eval dashboard/UI; artifacts + alerts suffice.
- No change to `ci.yml`'s deterministic job semantics.

## Dependencies
- **Q-06 approved by the founder and recorded (D-0xx)** — hard gate (autorun rule 5).
- E01-04 committed (registry/judge tier, cost counter). P0-012 merged (alert seam + D-042 destination).
- **Founder actions (platform-level, once):** `ANTHROPIC_API_KEY_CI` GitHub secret; mark `ci-evals` required in branch protection. The Builder never creates secrets.

## Expected modules affected
New: `.github/workflows/ci-evals.yml`, `eval/prompt-manifest.(json|ts)`, `eval/prompt-manifest.test.ts`, `scripts/eval-budget.mjs` (wrapper), optional `src/app/api/internal/ci-alert/route.ts` (bearer `CRON_SECRET`, calls `sendOpsAlert`). Modified: `eval/README.md`, `.github/workflows/ci.yml` (comment only), `package.json` (`eval:ci`, `eval:nightly` scripts), `09-testing-strategy.md`, `.env.example` (`EVAL_CI_BUDGET_USD` documented).

## Database impact
None.

## Migration impact
None (explicit).

## API impact
Optional internal alert route (bearer-gated, no tenant data).

## UI impact
None.

## Permission impact
None.

## Tenant-isolation impact
None (evals run against fixtures; the internal route carries no shop data).

## Security impact
CI key scoped + budget-capped; fork PRs cannot access it; alert route bearer-gated; no prompt content in alerts (suite names + counts only).

## Idempotency requirements
Nightly re-runs are independent; alert dedupe by the seam's burst guard.

## Observability requirements
Eval pass/fail counts per suite in the artifact; nightly failure alert (SEV-3/SEV-2 per suite class); CI budget-abort is a distinct failure reason.

## Analytics requirements
None.

## Feature flag
None (CI configuration).

## Automated tests
- Manifest source-scan test (new prompt without manifest entry fails `npm test`).
- Path-filter mapping unit test (changed files → suite set), including "no prompt files changed → job skipped".
- Budget wrapper unit test (abort on cap).
- Dry-run of the workflow via `act` is optional; at minimum a PR touching `persona.ts` (a no-op comment change reverted in the same PR is **not** allowed — instead the Builder demonstrates on the batch branch by a temporary commit that is reverted before the ticket commit? No: keep the branch clean — demonstrate with a workflow_dispatch input `suites=` and record the run URL).

## Manual acceptance procedure
1. **Founder:** Q-06 approved + recorded; CI secret created; branch protection updated (record in `autorun-log.md`).
2. Builder: `workflow_dispatch` the `ci-evals` job with `suites=classification` → runs, uploads artifact, passes within budget.
3. Builder: trigger the nightly via `workflow_dispatch` → artifact + (on a forced failing case via input) an alert arrives at the D-042 destination.
4. Reviewer (Cursor): confirm the manifest covers every prompt site listed in this ticket's references.

## Failure cases
- Budget exceeded → job fails with reason `budget`; not a prompt regression — documented triage.
- Provider outage during nightly → alert says `provider_error`, not `regression`.
- Fork PR → job skipped honestly; maintainers re-run after pull.

## Rollback strategy
Delete/disable the workflow; deterministic CI unaffected.

## Definition of done
`../12-definition-of-done.md` plus: Q-06 decision recorded before start (else the ticket is not started — HARD STOP recorded); one real path-filtered run + one nightly run URLs in the close record; manifest test committed; `eval/README.md` + `09` updated; founder actions recorded with status.

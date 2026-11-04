# Claude Code: next Gradia Agent OS build

_Prepared 2026-11-04. Start from current `origin/main`; do not reuse a stale Claude
checkout. Read `AGENTS.md`, `docs/AI_WORK_LOG.md`, the five September 11 governing
documents, `AGENTIC_OS_MASTER_BUILD.md` and `NEXT_BUILD_ORDER_2026-11-04.md`._

## First assignment: PR A, onboarding baseline backend

Implement `docs/product/ONBOARDING_BASELINE_ASSESSMENT.md` as a backend-only,
reviewable slice.

Required deliverables:

1. Versioned finite question/answer schema with bounded values, units and explicit
   `unknown` support.
2. Tenant-bound immutable assessment revisions; one baseline pointer may advance
   without mutating earlier revisions.
3. Server-derived authorization: owner submit/supersede, delegated manager draft,
   staff/revoked/anonymous denial.
4. Evidence classes and observation windows; deterministic formulas only.
5. Minimal starting-point and comparable-window DTOs for Cursor. A read failure is
   unavailable, never zero. No model prose in the DTO.
6. Disposable from-zero migration and integration tests for concurrency,
   immutability, cross-shop denial, revocation, invalid units, unknown-versus-zero
   and non-comparable windows.

Do not edit onboarding UI in this PR. Do not add analytics vendors, lead scoring,
an opaque efficiency score, revenue claims or credentials. Do not modify current
onboarding records destructively.

## Second assignment: PR B, immutable definitions

Continue `CLAUDE_AGENT_OS_INTERNALS_2026-11-03.md` Assignment 1. Persist immutable
employee-definition revisions and an atomic active pointer. Activation compiles
server-loaded policy, memory, tool, connector, budget and evaluation evidence.
Return the minimal builder/activation DTO Cursor needs. No second agent schema.

## Third assignment: PR C, lifecycle completion

Extend `20261029120000_custom_agent_run_lifecycle.sql`, `custom_agent_runs`, pending
actions and current provider proofs. Add only the missing step/command/attempt,
heartbeat, cancellation and reconciliation evidence. Prove crash recovery and
unknown outcomes without a second executor.

## Fourth assignment: PR D, Call Copilot ingress

Implement only the ingress and consent half of
`docs/product/WHISPER_CALL_COPILOT.md`:

- inbound human-first bridge through current telephony/voice-provider seams;
- finite capture states: off, disclosure_pending, consented, declined, paused,
  capturing, partial, ended, unknown;
- immutable disclosure/consent evidence and provider IDs;
- extension of current `call_records` and voice `interactions` rather than a new
  call-history store;
- ordered/idempotent callback handling, capture gaps and unknown completion;
- zero audio/model calls when consent is declined, missing or uncertain.

No live provider, shared database, number routing, production migration or call.
Use fixtures and a disposable stack. Do not build CRM extraction in this PR.

## Fifth assignment: PR E, extraction and proposals

Add a bounded structured extractor behind the common model boundary. Every proposed
field cites transcript spans and exact call/revision identity. Reuse customer,
vehicle, pending-action, approval, decision and reviewed-memory contracts. Initial
CRM writes are approval-required. Add injection, PII/payment-data, partial transcript,
ambiguity, stale evidence and cross-shop tests.

## Sixth assignment: first-class quote creation

After immutable definitions and the selected lifecycle are merged, implement
`docs/architecture/AGENT_QUOTE_AND_JOB_CAPABILITIES.md` as a separate PR. Add the
missing `quote.create` Control Center/Agent OS operation and route the interactive
Gradia Agent, Call Copilot and configured employee through the existing
`create_quote` pending action and `executeCreateQuote` executor. Do not create a new
quote engine, accept model prices, combine create/send/discount/booking authority or
build repair orders.

## Handback requirements

Stop after each PR-sized slice for review. Report exact base/head, migration names,
authority changes, commands/totals, disposable database evidence, limitations and
the DTO Cursor may consume. Never merge, deploy, activate providers/crons, change
shared data or lift production freezes without explicit authorization.


# E09 — Gradia Differentiation

_Created 2026-07-25 by the Organizer. Phase: **P9**. Status: planned._

## Objective

Ship the defensible layer no competitor matches: Opportunity Engine v1 (one ranked "money on the table" surface), the earned-autonomy graduation UX, owner-facing memory correction, a post-call voice quote verifier, and prompt-injection hardening with its own eval suite.

## User outcome

Home shows the owner exactly where money is sitting — lapsed regulars due for coating maintenance, quotes going cold, revival candidates — each with a one-tap staged action and a plain-English "because." Agents that earn trust get offered autonomy with evidence ("approved unedited 46 of 48 times — let it run?"). The owner can fix or forget anything Gradia mis-remembered. Voice never misquotes a price silently.

## Business reason

The trust dial is the locked differentiator: "every competitor is autonomous-first with no real off switch; Gradia is control-first with autonomy as a paid choice" (WHAT_GRADIA_DOES). The audit calls the foundations "unusually strong" and the opportunity engine PARTIAL-with-fuel-missing (docs 03/11/12 items 20–25). This epic converts architectural discipline into visible product moat — and drives Package-2 upgrades (autonomy graduation is the upsell moment).

## Current foundation

- Whisper-suggestion sweep + revival candidates + `maintenance_schedule` (armed; consumed by E06 for recurrence — this epic consumes it for *offers*).
- `trust.ts` evidence-based autonomy recommendations from resolution telemetry — already computed, thinly surfaced (audit doc 12 item 22 "this is the moat").
- Glass Box `action_decisions` "because" lines; lifecycle states (wired in E03); TCPA-gated win-back audiences; `pending_actions` staging for every suggested action.
- Draft verifier (cross-model critic) as the pattern for the voice quote verifier; 3-tier eval harness for the injection suite.

## Missing work

1. **Opportunity Engine v1:** unify the three suggestion sources into one ranked, deduplicated surface (score = value × recency × confidence — deterministic, explainable, no percentage display per BUILD_REFERENCE); each opportunity → staged action; dismiss/snooze with telemetry; Home placement per HOME_REDESIGN amendment discipline (no nudge-card regression — §8-A5/A8 says no nudge cards, so this is a *section*, decision-queue the exact surface).
   **Feed taxonomy (added 2026-07-27 — the founder-required target set; v1 ships the sources whose domains exist, later types activate as their source epic lands):** unanswered leads (E03), stale quotes (P0-009 data), lapsed customers + high-value-going-inactive (E03 lifecycle), maintenance due (existing `maintenance_schedule`), calendar gaps (E02 availability), failed payments (E05), unused entitlements + membership opportunities (E06), fleet renewal risks (E06), missing review requests (existing review machinery). Each feed type declares its source domain; a type whose domain hasn't shipped does not appear — no fabricated opportunities.
   **Per-opportunity contract (founder-required fields):** why detected (the "because" line from real rows), supporting records (deep links), estimated value **only when responsibly calculable** from real figures (else omitted, never guessed), recommended action (→ staged approval), qualitative confidence (never a percentage), approval requirement (which floor applies), and **result tracking** (actioned → outcome recorded, feeding the ranker and the E08 recovered-revenue report).
2. **Autonomy graduation UX:** surface `trust.ts` offers with evidence; accept/decline flows; per-agent trust timeline; downgrade path equally visible (trust is bidirectional).
3. **Memory correction:** owner edit/forget on interactions + whisper summaries (audit doc 03 "Memory correction NOT_FOUND"); corrections propagate to embeddings (delete + re-embed).
4. **Voice quote verifier:** post-call check that spoken prices matched `service-pricing`; mismatches → Activity with the transcript span flagged (audit doc 12 item 24; closes prompt-only enforcement gap, doc 07 weakness 7).
5. **Prompt-injection hardening:** delimiter/instruction-hierarchy pass over drafters/classifiers, injection eval suite in the harness, extra scrutiny on autopilot-eligible drafts (doc 07 weakness 2).

## Domain entities

New: `opportunities` (source ref, score inputs, state: open/actioned/dismissed/snoozed). Modified: interactions (correction/tombstone fields), call_records (verifier verdict).

## Backend services

`opportunity-engine.ts` (deterministic ranker + sweep cron), trust surfacing extensions, memory-correction module (embedding lifecycle), `voice-quote-verifier.ts` (post-call worker on the LLM seam), hardened prompt-assembly helpers.

## UI surfaces

Home opportunity section (placement decision above); Receptionist agent cards: trust timeline + graduation offers; customer file + Activity: "fix this memory" affordances; Activity: verifier flags with transcript deep-link.

## Integrations

None new. All rides existing engines + the E01 LLM seam.

## Security implications

Injection hardening is itself the security work; memory correction must tombstone, not silently rewrite audit history (corrections logged); graduation changes are auditable mode switches (BUILD_REFERENCE §5 invariant).

## Tenant implications

Standard scoping; opportunity sweep is per-shop cron work under the E10-bound job model — keep sweeps bounded and idempotent (trigger_ref uniques from P0 patterns).

## Migration implications

Additive tables/columns. Embedding delete/re-embed path is new operational surface — runbook note under ai-provider-outage.

## Product analytics

Lights up: `First revenue opportunity acted on` (canonical), `First AI action approved` enrichment (source=opportunity). Graduation accept/decline as candidate events (decision queue).

## Dependencies

E03 (lifecycle fuel — hard), E01 (LLM seam for verifier), E02 (booking actions from opportunities respect availability), E08 helpful (attribution proves opportunity ROI). **Event-processing bar (added 2026-07-27, roadmap rule 9 — hard): P0-005/006/007 idempotency + P0-012 alerting complete before any E09 autonomy expansion; every E09 ticket expanding autonomous execution on a webhook/cron path states its idempotency basis.** Decisions: Home surface placement (queue); graduation offer thresholds (product tuning, Organizer + founder).

## Risks

- Opportunity spam kills the surface — hard caps, dedupe against open cards, under-claim scoring; dismissals must teach the ranker.
- Memory correction vs audit integrity tension — tombstone design must satisfy both (ADR).
- Injection hardening can regress draft quality — eval-gated per locked principle #6.

## Non-goals

No percentage confidence anywhere (design law), no fully-autonomous graduation (floors immovable, D-021), no ML-trained ranker (deterministic + explainable first), no competitor-style "AI insights" text blobs — numbers traced to rows only.

## Feature flags

`FEATURES.opportunityEngine`, `FEATURES.autonomyGraduationUx`, `FEATURES.memoryCorrection`, `FEATURES.voiceQuoteVerifier`.

## Testing requirements

Ranker determinism + cap/dedupe tests; graduation offer threshold tests on seeded telemetry; memory correction: embedding removed, tombstone persists, audit trail intact; verifier golden calls (match/mismatch fixtures); injection eval suite red-teams every drafter/classifier and gates their prompts in CI.

## Rollout plan

Verifier + injection hardening first (invisible safety), memory correction second, graduation UX third, Opportunity Engine last (needs lifecycle data accumulating from E03). Pilot cohort feedback into `customer-feedback/` before default-on.

## Acceptance criteria

1. Home shows ranked opportunities, each traced to source rows with a "because" line; acting stages the right approval; dismiss/snooze persist and inform ranking.
2. An agent meeting evidence thresholds receives a graduation offer; accept flips mode auditable; floors still hold (locking tests).
3. Owner corrects a mis-heard whisper fact; retrieval never returns it again; the audit trail shows the correction.
4. A seeded call with a wrong spoken price is flagged in Activity within one sweep cycle.
5. Injection eval suite passes; a known-injection fixture cannot steer an autopilot-eligible draft.

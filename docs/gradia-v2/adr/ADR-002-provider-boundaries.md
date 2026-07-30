# ADR-002 — Provider Boundaries: Gradia Domains Depend on Gradia-Owned Interfaces

**Status:** accepted (founder-approved 2026-07-27, recorded as decision D-029)

## Context

The 2026-07-20 audit found the seam discipline uneven: voice (`voice-provider.ts`), telephony (`telephony-provider.ts`) and CRM (`crm-provider.ts`) are genuinely seamed, but the LLM layer has **no provider seam** — model IDs hardcoded in ~14 modules (grep-verified 2026-07-27), embedding vendor + dimension baked into the schema (audit docs 07/09) — and booking hard-requires Aurinko with the external calendar acting as source of truth (`approvals.ts:686`, reversed by D-013). The vendor amendment of 2026-07-27 classifies providers (core / ai / transitional / customer-integrations) and needs a binding boundary rule so classification has teeth.

## Decision

**Gradia domains depend on Gradia-owned interfaces, not vendor-specific behavior.**

Required boundaries:

| Domain | Interface | Providers behind it | State today |
|---|---|---|---|
| Calendar | `CalendarProvider` | Aurinko / Google Calendar / Microsoft Graph | Partial — Aurinko called via `aurinko.ts`; interface + native source of truth land in E02 |
| AI gateway | `ModelProvider` | Anthropic / OpenAI | **Missing** — the E01 LLM-seam work builds it (model registry, retries, timeouts, cost/latency/failure recording; no hardcoded model IDs in app modules). Task aliases, fallback chains, prompt/model versioning, and the embedding/voice/transcription scope exclusions are specified in `../02-target-architecture.md` §AI gateway (2026-07-27) |
| Voice | `VoiceProvider` | Vapi / future | Exists (`voice-provider.ts`) — preserve |
| Telephony | `TelephonyProvider` | Twilio / future | Exists (`telephony-provider.ts`) — preserve |
| Payments | `PaymentsProvider` | Stripe / future | Stripe direct today; interface formalized with E05 (Connect) |
| Customer integration | `CRMConnector` | Jobber / Housecall Pro / future | Exists (`crm-provider.ts`) — preserve |

Provider-specific IDs, cursors, payloads and synchronization state remain inside integration records and provider adapters wherever practical. **Core business entities use Gradia-owned identifiers**; provider identifiers (e.g. `aurinko_event_id`, Stripe refs, Twilio SIDs) are mirror/sync fields, never the primary key of a domain concept.

## Alternatives considered

- **Status quo (seams where they happen to exist):** rejected — the LLM gap already makes model upgrades a shotgun change and violates locked principle #8's spirit.
- **Full hexagonal/ports-and-adapters refactor now:** rejected — over-scoped for a pre-alpha solo-founder codebase; boundaries are introduced per-epic (E01 AI gateway, E02 calendar, E05 payments) rather than as a big-bang refactor.

## Consequences

- E01 gains the AI-gateway deliverable explicitly; E02 delivers `CalendarProvider` with Aurinko as the first adapter; E05 formalizes `PaymentsProvider`.
- New-provider adoption must satisfy the checklist in `../vendors/README.md` (including this boundary) before founder approval.
- Embeddings remain the acknowledged hardest exit (dimension in schema) — accepted risk until a re-embed pipeline is justified.
- No application code changes in the amendment session that created this ADR; enforcement begins with the epics above and Cursor-Reviewer checks.

## Links

D-029/D-030 (`../11-decision-log.md`) · `../vendors/README.md` + `../vendors/registry.md` · audit docs 02/07/09 · E01/E02/E05 epics · Q-19/Q-20/Q-21 (`../program/decision-queue.md`)

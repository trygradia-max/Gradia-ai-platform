# Gradia v2 — Planning & Operating System

_Created 2026-07-25 by the Organizer. This directory is the single source-of-truth **layer** for planning, architecture decisions, tickets, and operating contracts. It references — never duplicates — the existing documents scattered across the repo. Planning docs only: nothing in this directory is application code._

## What this is

Gradia's documentation grew organically across the repo root, `platform/`, `platform/docs/`, `platform/docs/audit/`, `_docs/`, and a trail of handoffs and run logs. This layer reconciles them:

- **`16-document-source-map.md`** records every existing document, its status (current / historical / superseded / temporary), and **which document wins when sources disagree**. Read it before trusting any older doc.
- **`11-decision-log.md`** is the approved product/architecture decision record. New decisions land here (or as ADRs in `adr/`) — never silently in code or chat.
- **`10-roadmap.md`** converts the scattered plans into one ordered roadmap (P0–P10).
- **`tickets/`** holds bounded, implementable ticket specifications. Builders implement tickets, nothing else.
- **`agent-briefs/`** defines the four operating roles: Organizer, Builder, Cursor Reviewer, Release Reviewer.

## Documentation precedence (short form — full model in 16)

1. Current **audited application behavior** (`platform/docs/audit/`)
2. Approved **Gradia v2 decision log** (`11-decision-log.md`)
3. Approved **Gradia v2 ADRs** (`adr/`)
4. Approved Gradia v2 **product principles + target architecture** (`00`, `02`)
5. Current `GRADIA_MVP_PLAN.md`
6. Current feature-specific specifications (`_docs/*_SPEC.md`, `docs/BUILD_REFERENCE.md`)
7. Historical project briefs and visions (`PROJECT_BRIEF.md`, waitlist specs)
8. Run logs and temporary handoffs

Historical documents never override audited current behavior or newly approved decisions.

## Directory map

| Path | Contents |
|---|---|
| `00-product-principles.md` | What Gradia is, guarantees, non-negotiables |
| `01-current-state.md` | Condensed current reality (from the 2026-07-20 audit) |
| `02-target-architecture.md` | Target architecture, preserved invariants, explicit non-migrations |
| `03-domain-model.md` | Entities, relationships, current vs target schema direction |
| `04-capability-map.md` | 28 capabilities × status/foundation/gaps/phase/flags/evidence |
| `05-feature-requirements.md` | Requirement statements per capability area |
| `06-ui-information-architecture.md` | Navigation, screens, IA rules |
| `07-onboarding-and-imports.md` | Onboarding wizard + import staging/mapping/rollback requirements |
| `08-security-and-reliability.md` | Security posture, tenancy, idempotency, incident readiness |
| `09-testing-strategy.md` | Test tiers, CI gates, eval gating, coverage rules |
| `10-roadmap.md` | Ordered P0–P10 roadmap |
| `11-decision-log.md` | Approved decisions (this is precedence layer 2) |
| `12-definition-of-done.md` | What "complete" means for any ticket |
| `13-release-strategy.md` | Branch/release/flag/rollout model |
| `14-product-analytics.md` | Canonical activation/lifecycle event set |
| `15-cost-and-margin-model.md` | Pricing, credits, margin floors, trial cost controls |
| `16-document-source-map.md` | Precedence + full inventory of existing docs |
| `adr/` | Architecture Decision Records (numbered) |
| `epics/` | One file per major epic (E00–E10) |
| `tickets/` | Bounded ticket specs (`P0-001` …) + index |
| `program/` | Sprint state, backlog, WIP, dependency map, decision queue |
| `releases/` | Release notes/records per release |
| `runbooks/` | Incident runbooks (SEV-0..3) |
| `risks/` | Risk register |
| `vendors/` | Classified provider registry (`core/` · `ai/` · `transitional/` · `customer-integrations/` · `planned-evaluations/` + `registry.md`) |
| `research/` | Pointers to `_docs/research/` + new research |
| `customer-feedback/` | Structured pilot/customer feedback |
| `ui/` | Design system north star, flows, state matrix |
| `marketing-site/` | Marketing-site planning (claims discipline) |
| `agent-briefs/` | Operating contracts for the four roles |
| `archive/` | Superseded gradia-v2 docs (copy-in only; originals stay in place) |

## How work flows

```
Founder decision ──▶ 11-decision-log.md (or program/decision-queue.md while open)
Architecture choice ─▶ adr/ADR-NNN
Scoped outcome ──▶ epics/E##-*.md
Bounded work ──▶ tickets/P#-###.md  (status: draft → ready → in-progress → in-review → done)
Sprint state ──▶ program/current-sprint.md (WIP limits enforced there)
Ship ──▶ releases/ + 13-release-strategy.md gates
```

Rules that bind every role:
- No ticket enters implementation until its dependencies and decisions are resolved (`program/blocked.md` otherwise).
- **One ticket = one branch.** There is never a combined "build Gradia v2" branch; work merges ticket-by-ticket through the gates in `13-release-strategy.md`.
- WIP limits: max **2** active implementation tickets; max **1** database-sensitive ticket; max **1** payment/tenancy/calendar high-risk ticket; one Builder and one Reviewer per ticket.
- Founder-level decisions are never made silently — they go to `program/decision-queue.md`.
- A capability is never marked complete because a table or page exists — see acceptance evidence in `04-capability-map.md`.

## Roles (contracts in `agent-briefs/`)

- **Organizer** — owns this directory: roadmap, tickets, sprints, decision queue, reconciliation. Does not implement.
- **Builder** — implements exactly one ready ticket at a time under the ticket's scope. Does not decide scope.
- **Cursor Reviewer** — reviews each ticket's diff against the ticket spec + `12-definition-of-done.md`.
- **Release Reviewer** — gates releases against `13-release-strategy.md` and the go-live checklists.

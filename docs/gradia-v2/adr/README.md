# ADRs — Architecture Decision Records

_Created 2026-07-25 by the Organizer. Precedence layer 3 (see `../16-document-source-map.md`)._

ADRs record **how** decisions (mechanisms), while `../11-decision-log.md` records **what** decisions (product/scope). An ADR is required when a Builder or Organizer must choose between technical mechanisms with lasting consequences — e.g. the P0-005 idempotency mechanism (per-table uniques vs a `provider_events` table), the E01 tenant-scoping mechanism (`forShop()` helper vs Postgres session-variable RLS), or the P10 outbox design.

## Format

`ADR-NNN-<slug>.md` with sections: **Status** (proposed / accepted / superseded-by-ADR-NNN) · **Context** · **Decision** · **Alternatives considered** · **Consequences** · **Links** (tickets, decision-log IDs, audit evidence).

## Rules

- Proposed by anyone; **accepted only with founder or Organizer-with-founder-mandate sign-off**.
- An accepted ADR that contradicts an older doc gets a row in `../16-document-source-map.md` §Contradictions.
- Pre-existing locked architecture principles (root `CLAUDE.md`, sharpening brief) are treated as accepted ADRs by reference — do not restate them here unless amending, which requires founder approval.

## Index

- **ADR-002 — Provider boundaries** (`ADR-002-provider-boundaries.md`) — accepted 2026-07-27: Gradia domains depend on Gradia-owned interfaces (CalendarProvider, ModelProvider, VoiceProvider, TelephonyProvider, PaymentsProvider, CRMConnector), never vendor-specific behavior. Pairs with D-029/D-030.
- _ADR-001 is reserved for the webhook-idempotency mechanism chosen during P0-005 (per-table uniques vs claim table). By design it will land **after** ADR-002 — numbering reflects reservation order, not acceptance order._

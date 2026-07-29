# Vendor — Jobber

> **Classification:** customer-integrations · **Status:** optional · Amended 2026-07-27 (vendor-architecture amendment, D-030/ADR-002). Registry: ../registry.md

_Created 2026-07-25 by the Organizer. Vendor registry entry. Facts grounded in the 2026-07-20 audit (docs 02, 03) and `_docs/GRADIA_CRM_INTEGRATIONS.md`; unverified items are marked. Runbook: `docs/jobber-go-live.md`._

## Approved direction (2026-07-27)

- **Optional customer integration — not a foundational Gradia provider.**
- **Customer-demand driven** and **feature-flagged**.
- Approved uses: **migration, temporary synchronization, one-way export**.
- **Core Gradia workflows must not depend on Jobber**; Gradia remains fully operational without it (the `CRMConnector` seam no-ops cleanly).
- **Re-evaluate ongoing synchronization after Gradia reaches operational parity** (post-E03) — decision Q-20. Never make it a core dependency.

## Purpose
External CRM push: mirror approved leads/customers/bookings into the shop's Jobber account (one-way, best-effort). Sits behind the `crm-provider.ts` seam alongside Housecall Pro. Long-term, Gradia's own CRM (E03+) is the system of record; Jobber push is a migration bridge/coexistence feature.

## Data exchanged
Customers/clients and job/booking details pushed outward; Jobber ids mirrored back onto Gradia rows (`appointments` carries Jobber mirror ids). No inbound sync established in the audit (one-way push only).

## Authentication
OAuth with CSRF state nonce in HttpOnly cookie, verified on callback (audit doc 06); token refresh handled (audit doc 03 integration-reconnect PARTIAL — no owner-facing reconnect alerts).

## Webhooks
None consumed (no inbound Jobber webhook in the audit's route matrix).

## Rate limits
REQUIRES VERIFICATION (Jobber developer docs).

## Failure behavior
Push is best-effort — a Jobber failure never blocks the Gradia-side action (booking executor pushes "CRM best-effort"). Consequence: silent divergence between Gradia and Jobber is possible; no reconciliation exists.

## Idempotency
Mirror-id columns prevent obvious re-creates; a full idempotency contract REQUIRES VERIFICATION against live behavior.

## Cost model
No direct cost to Gradia established; the shop owns its Jobber subscription.

## Monitoring
None; best-effort failures are console-logged at most (silent-degradation pattern; P0-012 improves the alerting substrate).

## Test environment
Seam no-ops cleanly with no CRM connected (GO_LIVE_CHECKLIST NEXT-4 smoke). Live push verified per go-live runbook; a Jobber sandbox/dev account REQUIRES VERIFICATION.

## Known audit gaps
- One-way push only; no import-from-Jobber (E03's import wizard is the planned inbound path per D-006/D-022).
- No divergence detection/reconciliation.
- No owner-facing alert when the connection breaks.

## Backup or exit strategy
Behind `crm-provider.ts` (locked principle #8) — adding/removing CRM targets is contained. As Gradia's native CRM matures, Jobber becomes optional; the exit is the product strategy itself.

## Owner
Founder (Harry).

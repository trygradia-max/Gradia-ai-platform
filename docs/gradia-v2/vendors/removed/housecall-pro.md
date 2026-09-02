# Vendor — Housecall Pro

> **Classification:** customer-integrations · **Status:** quarantined · Amended 2026-07-27 (vendor-architecture amendment, D-030/ADR-002). Registry: ../registry.md

_Created 2026-07-25 by the Organizer. Vendor registry entry. Facts grounded in the 2026-07-20 audit (docs 00, 03, 08, 13) and `_docs/GRADIA_CRM_INTEGRATIONS.md`; unverified items are marked. **This integration is UNVERIFIED end-to-end — treat as beta-at-best until the founder verification run.**_

## Approved direction (2026-07-27) — QUARANTINED

- **Not publicly marketed** — and stays that way.
- **Feature flag remains disabled.**
- **No new product investment.**
- Existing API shapes **require live verification** (`TODO(verify)` ×3 — never tested against a live account).
- **No core Gradia workflow depends on it** (audit finding; re-verified by the review ticket).
- **Import-only support vs complete removal** is evaluated via ticket `../../tickets/P3-001-housecallpro-dependency-review.md` and decision Q-19.
- **Ongoing synchronization is considered only when a paying customer explicitly requires it.**

> **Organizer recommendation:** "Use Housecall Pro as an import source or remove it after dependency review. Do not maintain it as a core bidirectional integration without customer demand."

## Purpose
Second external CRM push target behind the `crm-provider.ts` seam (same role as Jobber): mirror approved customers/bookings into Housecall Pro, one-way, best-effort.

## Data exchanged
Same shape as Jobber: clients and job details outward, HCP mirror ids back onto Gradia rows. **Every endpoint shape is an educated guess** — `housecallpro.ts:22,265,435` carry explicit `TODO(verify)` markers (audit doc 08).

## Authentication
OAuth with CSRF state protection (same pattern as Jobber, audit doc 06); token refresh handled. Live auth flow REQUIRES VERIFICATION.

## Webhooks
None consumed.

## Rate limits
REQUIRES VERIFICATION (HCP developer docs).

## Failure behavior
Best-effort push; failures never block Gradia-side actions. Given unverified endpoint shapes, the realistic failure mode is **first real use fails** (audit doc 10 lists this among the things keeping the platform out of public-beta).

## Idempotency
REQUIRES VERIFICATION — cannot be assessed until endpoint shapes are confirmed live.

## Cost model
No direct cost to Gradia; shop owns its HCP subscription.

## Monitoring
None; same silent-degradation caveat as Jobber.

## Test environment
No live account has ever been tested (audit open question #12). The settings card renders as first-class, which overstates maturity (audit doc 08). Founder must run the verification against a live/dev HCP account before alpha claims — audit roadmap item 13.

## Known audit gaps
- **All endpoint shapes unverified** (`TODO(verify)` ×3) — the single biggest gap; blocks any claim that HCP integration works.
- Settings UI overstates completeness relative to that risk.
- Same one-way/no-reconciliation limits as Jobber.

## Backup or exit strategy
Behind the CRM seam; if live verification fails badly, the honest fallback is flag the HCP card off (gate, don't delete) until fixed. No exit cost — nothing depends on it.

## Owner
Founder (Harry) — verification run is a founder action (needs a live HCP account).

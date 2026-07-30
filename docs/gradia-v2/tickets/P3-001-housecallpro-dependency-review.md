# P3-001 — Housecall Pro Dependency Review

_Created 2026-07-27 by the Organizer (vendor-architecture amendment). Specification only — do not implement in an Organizer session._

- **Ticket ID:** P3-001
- **Epic:** E03 — CRM and import completion (phase P3; deliberately **not** ahead of P0 stabilization)
- **Status:** draft — becomes ready when P0 exits and Q-19 needs its evidence; founder may pull it earlier, it touches no production behavior
- **Priority:** Medium (quarantine already contains the risk; this ticket produces the decision evidence)
- **Objective:** produce a complete, verified inventory of every Housecall Pro dependency in the platform and a costed recommendation between import-only, dormant-connector, and removal (feeds decision Q-19).
- **User outcome:** owners are never exposed to an integration whose API shapes are unverified (`housecallpro.ts:22,265,435` `TODO(verify)` — audit docs 08/13); a future paying customer with HCP data gets a deliberate answer (import path or honest "not supported") instead of a guessed one.

## Current code references (from the 2026-07-20 audit — re-verify at execution)

`src/lib/housecallpro*.ts` behind `crm-provider.ts`; `housecallpro-settings-card.tsx` (env-gated); OAuth start/callback with CSRF state (audit doc 06 route matrix); `shops` HCP credential columns (god-table, audit doc 05); token-refresh path (audit doc 03 "integration reconnect"); `docs/jobber-go-live.md`-style runbook coverage for HCP is part of the inventory question.

## Exact scope

1. Enumerate every HCP code reference: modules, routes, server actions, UI components, seam registrations.
2. Enumerate active routes/services (OAuth start/callback, push calls) and whether any fire without owner action.
3. Enumerate database fields (shops columns, mirror IDs on appointments/customers) and their population state.
4. Enumerate environment variables, feature flags, and gating behavior.
5. Enumerate tests touching HCP (unit + the source-scan/locked tests).
6. Enumerate documentation references (go-live docs, `_docs/GRADIA_CRM_INTEGRATIONS.md`, settings copy).
7. Determine whether ANY current Gradia workflow depends on HCP (expected answer per audit: none — verify).
8. Assess feasibility + cost of an **import-only** posture (HCP as a one-time migration source through the D-022 import standard).
9. Estimate **removal** cost (code, columns left dormant per the additive-DB rule, tests, docs).
10. State the customer-demand bar required to retain ongoing synchronization.
11. Deliver a written recommendation to Q-19 with the evidence attached.

## Explicit non-goals

No code removal, no flag flips, no new HCP features, no live API verification beyond read-only credential-less checks (live verification is the founder-account item in `../program/blocked.md`), no marketing changes (it is already unmarketed per D-030).

## Dependencies
P0 exit (sprint discipline only — no technical dependency). Informs Q-19. Coordinates with E03 import-wizard design if import-only is chosen.

## Impact assessment
- **Expected modules affected:** none (read-only review; report is the deliverable).
- **Database impact / Migration impact / API impact / UI impact / Permission impact:** none in this ticket; the follow-up ticket implementing Q-19's outcome carries them.
- **Tenant-isolation impact:** review documents which HCP paths run service-role and their `.eq("shop_id")` discipline (feeds P0-011's inventory if not already covered).
- **Security impact:** documents HCP credential storage (encrypted columns on `shops`) and what removal would orphan.
- **Idempotency requirements:** n/a (review); notes whether HCP push honors provider-ref idempotency for the follow-up.
- **Observability requirements:** n/a; report notes existing HCP failure logging.
- **Analytics requirements:** none.
- **Feature flag:** none — review only; HCP's existing flag stays disabled throughout (D-030).

## Automated tests
None added (review ticket). The report must list which existing tests would break under removal vs import-only.

## Manual acceptance procedure
1. Read the report; confirm every scope item 1–10 has an answer with file references.
2. Spot-check three cited references against the code.
3. Confirm the recommendation states its customer-demand bar explicitly.
4. Q-19 queue entry updated with a link to the report.

## Failure cases
Inventory incomplete (grep misses indirect references) → require the seam-registration list plus a repo-wide case-insensitive sweep (`housecall|hcp`) as evidence. Review drifts into refactoring → out of scope, stop (Builder contract).

## Rollback strategy
n/a — produces a document. The implementing follow-up ticket (post-Q-19) carries its own rollback plan.

## Definition of done
Per `../12-definition-of-done.md` as applicable to a review ticket: report delivered under `../research/` (dated), Q-19 updated, follow-up ticket drafted matching the founder's Q-19 choice, no application changes made.

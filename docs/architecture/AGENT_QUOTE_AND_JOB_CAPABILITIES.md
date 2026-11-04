# Gradia Agent quote and job capabilities

_Current-state and target contract: 2026-11-04. This document does not activate
autonomous money actions, add a full repair-order system or change production._

## Current truth

Gradia already has one real quote engine:

- `src/lib/service-pricing.ts` is the shared menu/vehicle-size/condition price source.
- `src/lib/quotes.ts` builds auditable line items and totals.
- `src/components/gradia/quote-builder.tsx` and `src/app/actions/quotes.ts` provide the
  owner Quote Builder.
- `src/lib/vapi-tools.ts` can stage a `create_quote` proposal from a voice call.
- `src/lib/approvals.ts` creates the approved quote as `draft`, recalculating current
  menu prices at execution; the agent never sends it automatically.
- Public quote response, serialized booking, lead/pipeline linkage and guarded
  SMS/email delivery already exist.

The general Gradia Agent is not yet fully wired to this capability. The interactive
owner Agent's bounded tools omit quote creation, the Agent OS tool vocabulary has
`quote.send` and `quote.discount` but no distinct `quote.create`, and immutable
definition persistence/activation is still pending. Therefore the honest status is:

**Quote Builder exists; one voice path can propose a draft; general configured
Gradia employees cannot yet reliably select and execute quote creation end to end.**

## Target quote capability

Add a first-class `quote.create` operation without creating another price engine or
quote table. The configured Agent may:

1. Read the current customer, vehicle and menu under tenant/role scope.
2. Propose exact service selections, condition modifiers and notes with evidence.
3. Stage `create_quote` for review.
4. On approval, recalculate using current server-side menu/vehicle data and create
   one draft quote through the existing executor.
5. Keep `quote.send`, `quote.discount` and `booking.create` as separate permissions
   and approvals. Creating a draft never implies permission to send, discount or book.

Initial `quote.create` is `APPROVAL REQUIRED` with a hard approval floor. Ambiguous
service/vehicle/condition, unmatched menu items, changed evidence or stale approval
holds the action. Generated dollar amounts are never accepted as authority; current
server pricing wins at approval.

The operation must work for the interactive Gradia Agent, Call Copilot extraction
and a configured employee definition through the same pending-action/executor path.

## Jobs versus repair orders

Gradia currently treats an appointment as a lightweight job with booked, confirmed,
checked-in, in-progress, on-hold, completed, paid and closed states plus logistics,
photos and maintenance timing. That supports the approved MVP completion loop.

A full repair/work order is not built or approved for the current pilot. It would
require a separately reviewed domain for technician assignment, labor/parts/steps,
inspections, change authorization, tax/invoice handoff and customer signatures.
Do not disguise fields on `appointments` as a complete repair-order product.

The Agent may later propose bounded updates to the existing lightweight job, but
current human status actions remain authoritative until a separate operation matrix,
role model and acceptance suite are approved. No model may mark work completed,
paid or closed merely from conversation text.

## Acceptance for `quote.create`

- Owner Agent, Call Copilot and configured-employee fixtures stage the same validated
  pending-action contract and never write a quote before approval.
- Approval recalculates current server-side menu prices and creates one draft under
  replay/concurrency.
- `quote.create` grants do not authorize send, discount or booking.
- Wrong-shop references, revoked members, stale evidence, unmatched services and
  ambiguous vehicles fail closed before a quote write.
- Quote, lead and booking linkage remains idempotent and existing integration tests
  continue to pass.


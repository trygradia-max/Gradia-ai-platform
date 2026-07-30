# Flow — Membership Enrollment

_Created 2026-07-25 by the Organizer. Nothing exists today (audit: no promotions/memberships entities). Memberships are their own domain — not a flavor of recurring jobs or fleets (D-017)._

**Maturity:** TARGET.
**Phase/Epic:** E06 / P6 (depends on E05 payments for billing, E02 availability for included-visit scheduling).

## Entry point
Customer file → "Enroll in membership"; or a public enrollment link (post-E05); or quote acceptance upsell.

## User objective
Owner sells predictable recurring revenue ("$59/mo wash club"); customer gets included services without re-booking friction.

## Required data
Membership plan definition (name, price, billing interval, included services/visits per period, rollover rule, term); customer + payment method (Stripe Connect, E05); consent for recurring billing.

## Exact steps
1. Owner defines plans once in Settings (deterministic entitlement rules — what's included, how often).
2. From a customer file: pick plan → review terms → send enrollment link, or enroll in person.
3. Customer confirms + payment method saved via Stripe (Connect, off-session future charges authorized).
4. Membership record created: status active, period entitlements initialized.
5. Each period: billing fires (immutable payment events, idempotent on Stripe event id — D-023/D-024); entitlements reset per rollover rule.
6. Booking an included visit consumes an entitlement (visible balance); overage books as normal paid work.
7. Pause/cancel: status change with effective date; no retroactive ledger edits.

## System decisions
- Entitlement consumption is deterministic code; disputes resolvable from the ledger.
- Failed renewal → dunning states (past_due → paused) with owner visibility; never silent lapse.
- Membership pricing changes affect future periods only.
- High-ticket/financial actions require approval regardless of AI mode (D-021).

## AI involvement
Suggest-HITL only at the edges: drafting the enrollment offer message, win-back for lapsed members. Enrollment, billing, entitlements: no AI.

## Permissions
Plan definition: owner/admin. Enrollment: roles with sales rights. Cancel/refund: owner/admin.

## Error states
- Payment method declined at enrollment → membership not created; retry link.
- Renewal failure → past_due state, staged dunning message for approval.
- Plan deleted with active members → forbidden; plans archive instead (no dead entitlements).

## Empty states
- No plans: "No memberships yet. Define a plan once — Gradia handles billing and included visits."
- No members on a plan: honest zero with the enrollment link.

## Success state
Active membership with next-bill date, entitlement balance, and payment history — every figure traced to real rows.

## Next recommended action
Book the member's first included visit; enable the renewal-reminder automation (suggest-first).

## Mobile behavior
Customer enrollment link is mobile-first; owner-side plan setup usable on phone.

## Analytics events
`First payment collected` (if first-ever payment); membership-specific events (enrolled/renewed/canceled) to be added to the canonical set via decision queue — not invented here.

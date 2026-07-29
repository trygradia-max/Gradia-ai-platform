# E06 — Recurring Jobs, Memberships and Fleets

_Created 2026-07-25 by the Organizer. Phase: **P6**. Status: planned._

## Objective

Build the three repeat-revenue domains as **separate domains** (D-017): recurring jobs (schedule-driven repeat work), memberships (subscription plans with entitlements), and fleet accounts (company customers with many vehicles and batch service visits). Each gets its own model, UI, and billing hooks — no shared "repeat work" abstraction.

## User outcome

- **Recurring:** "every 3rd Tuesday, wash the Hendersons' two cars" books itself onto real availability, forever, visible ahead of time.
- **Memberships:** a shop sells "Unlimited Wash Club $79/mo"; Gradia bills it, tracks visits against entitlements, and flags lapsed members.
- **Fleets:** a realtor's 12-vehicle fleet is one account with per-vehicle history, batch visit scheduling, and one consolidated invoice.

## Business reason

Repeat revenue is what turns a detailer into a business — and what makes Gradia unremovable. The audit shows the seeds are planted but dead: `maintenance_schedule` armed on job completion and never consumed (doc 03 "Recurring services PARTIAL / Maintenance reminders PARTIAL — no reminder sender wired"). Competitors (research: GoHighLevel, Podium teardowns) don't own this niche workflow; it's differentiation with pricing power.

## Current foundation

- `maintenance_schedule` jsonb armed on job completion (unconsumed); appointment reminders + no-show ladder machinery.
- E02 availability engine (books the repeats), E05 payments (bills the memberships/fleets), E03 lifecycle + vehicles (per-vehicle history), `customers` spine (companies absent).
- Platform's own Stripe subscription code as a *reference* for membership billing mechanics.

## Missing work

**Recurring jobs:** recurrence rules (RRULE-subset — ADR), series entity + generated occurrences against availability, series edit semantics (this-one/all-future), conflict handling on generation (D-015 applies), consume `maintenance_schedule` into suggested recurrences.
**Memberships:** plan builder (price, period, entitlements), member enrollment (`ui/flows/membership-enrollment.md`), Stripe Connect subscription billing, visit redemption against entitlements, pause/cancel, dunning surface. *Parity additions (2026-07-27), build in E06:* **rollover rules** (unused entitlements: expire vs roll, per plan), **member pricing** (discounted service rates for members), **upgrade/downgrade** (plan changes on Stripe's proration defaults), **priority booking** (member flag consumed by availability/booking — E02 engine input).
**Fleets:** `companies` entity (customer-of-type-company + contacts), fleet vehicle roster, batch visit scheduling (`ui/flows/fleet-visit.md`), consolidated invoicing (E05), fleet pricing overrides. *Parity additions (2026-07-27):* **unit numbers** on roster vehicles (build in E06 — fleet operators identify by unit, not plate), **net terms** on consolidated invoices (build in E06 — invoice due-terms field + overdue surfacing), **purchase-order requirement** (PO number captured per visit/invoice when the account requires it — build in E06), **completion evidence** (per-vehicle photos/checklist rolled into the visit report — build in E06, reuses E04 machinery), **service agreements** (contract pricing + term records — deferred → post-pilot fast-follow, needs a real fleet account's shape), **account profitability** (deferred → E08 reporting). GPS/telematics/route optimization stay delayed (roadmap §rejects).

## Domain entities

New: `recurring_series` + occurrence links; `membership_plans`, `memberships`, `membership_redemptions`; `companies`, company↔customer contacts, fleet vehicle grouping. Modified: `appointments` (series ref), `vehicles` (company ownership), `invoices` (consolidated scope).

## Backend services

Three modules — `recurring.ts`, `memberships.ts`, `fleets.ts` — plus a generation sweep (cron) for series occurrences and membership renewal reconciliation. Kept deliberately separate per D-017.

## UI surfaces

Recurring: series editor on job/booking, upcoming-occurrences view on calendar. Memberships: plan builder in Settings, member badge + entitlement meter on customer file, enrollment flow. Fleets: company file (roster, visits, invoices), batch visit composer.

## Integrations

Stripe Connect (membership billing, consolidated invoices — E05 machinery). Calendar (E02). No new vendors.

## Security implications

Membership billing inherits E05's discipline (idempotent events, immutable ledgers, HITL on charges per D-021). **Auto-renewal vs the money-HITL floor is an open founder decision — Q-24 in `../program/decision-queue.md` (amended 2026-07-27):** whether consent-at-enrollment (human approves the series once; code executes renewals with audit + failure-to-HITL escalation) satisfies the floor is a floor *interpretation*, which only the founder settles. No membership-billing ticket is cut until Q-24 is decided; the ADR then records the mechanism.

## Tenant implications

All new tables shop-scoped under the E01 membership RLS pattern; fleets do NOT introduce cross-shop visibility (a national fleet spanning shops is out of scope).

## Migration implications

Three additive migration sets, sequenced one domain at a time (database-sensitive WIP limit). `maintenance_schedule` jsonb migrates into suggested `recurring_series` rows via a one-time backfill with preview.

## Product analytics

Lights up: `First revenue opportunity acted on` (maintenance-schedule→recurrence suggestions). Candidate additions (decision queue): membership_enrolled, recurring_series_created, fleet_visit_completed.

## Dependencies

E02 (hard — occurrences need availability), E05 (hard for memberships/fleet invoicing; recurring jobs can ship payment-free first), E03 (companies extend the customer spine cleanly only after single-truth pass). Decisions: D-017 approved; **renewal-HITL interpretation = founder decision Q-24 (blocks membership billing tickets)**; recurrence-rule scope ADR.

## Risks

- Recurrence edit semantics are a notorious complexity sink — constrain the rule grammar hard (no arbitrary RRULE).
- Membership entitlement disputes ("it said unlimited") — entitlement language must be explicit in the plan builder and receipts.
- Building all three at once violates the WIP spirit — sequence recurring → memberships → fleets.

## Non-goals

No shared repeat-work abstraction (D-017), no multi-shop fleets, no marketplace/consumer membership network, no proration engine beyond Stripe's defaults, no gift cards/packages (different product).

## Feature flags

`FEATURES.recurringJobs`, `FEATURES.memberships`, `FEATURES.fleetAccounts` — independent.

## Testing requirements

Recurrence generation property tests (DST, month-length, skip-on-conflict per D-015); series edit semantics suite; membership renewal idempotency replay + entitlement redemption race tests; consolidated invoice correctness (sum of visits = invoice, immutable); RLS suite extension; E2E per domain flow.

## Rollout plan

Recurring jobs first (no money dependency) → memberships on 2 pilot shops with real plans → fleets last with one pilot fleet account. Each domain GA's independently on its flag.

## Acceptance criteria

1. A recurring series generates conflict-free occurrences 90 days ahead; editing "all future" doesn't touch past rows.
2. A membership bills through Connect, redemptions decrement entitlements, cancellation stops billing and logs.
3. A fleet visit books 5 vehicles in one flow and produces one consolidated invoice whose lines trace to per-vehicle jobs.
4. Completed jobs propose recurrences from `maintenance_schedule` — the armed data finally fires.
5. All three domains demonstrably independent: each flag off leaves the other two fully functional.

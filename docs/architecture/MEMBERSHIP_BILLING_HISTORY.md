# Membership billing history and daily seat proration (Commercial Billing PR B)

_2026-11-04. Backend foundation only. No Stripe call, checkout, subscription, meter,
webhook, tax, dunning, refund, UI, deployment or live-mode change. Pricing authority
stays in `src/lib/approved-commercial-catalog.ts` (catalog `2026-11-03.v1`)._

PR A left seat proration as `seat_proration_unavailable` because nothing recorded
who was a billable operator *when*. `shop_memberships` is mutable current state:
role and active are updated in place and `revoked_at` is not cleared on
reactivation, so history cannot be reconstructed from it. This PR records it going
forward and computes proration only where the record is complete.

## What exists

| Piece | Location |
| --- | --- |
| Migration | `supabase/migrations/20261104140000_membership_billing_history.sql` |
| Pure daily proration | `src/lib/commercial-seat-proration.ts` |
| Preview integration | `src/lib/commercial-usage-preview.ts` (`membership` input, `invoiceTotal`) |
| Server wrappers | `src/lib/commercial-usage-service.ts` (`readCommercialPeriodPreview`, `correctMembershipBilling`) |
| Non-destructive upgrade verifier | `scripts/verify-membership-billing-migration.py` |

## Audit: every membership mutation path

| Path | Mechanism |
| --- | --- |
| Shop bootstrap (owner membership) | `team_bootstrap` trigger on `shops` inserts the row |
| Invitation acceptance, incl. reactivation | `team_accept_invite` INSERT … ON CONFLICT DO UPDATE |
| Owner role change, activation, revocation | `team_set_member` UPDATE |
| Direct trusted (service-role) writes | plain INSERT/UPDATE/DELETE; existing tests use them |
| Shop deletion | FK cascade |

Because direct writes exist, capture cannot live in the RPCs. A **row trigger on
`shop_memberships`** records every billing-relevant change (insert, role/active
update, delete) in the *same transaction*, whichever path made it. A failed capture
rolls the membership change back; a failed or refused membership change leaves no
evidence. Capability, display-name or `revoked_at`-only edits have no billing
effect and record nothing.

## Data model

- `commercial_membership_coverage` — one row per shop: `covered_from` and `basis`
  (`migration_snapshot` for shops that existed at migration, `shop_created` for
  later shops). Nothing before `covered_from` is claimed.
- `commercial_membership_events` — append-only, tenant-bound, per-shop gapless
  `shop_seq`. Fields: user and membership identity (plain ids; the user may later be
  deleted), `kind` (`snapshot` | `change` | `correction`), previous/new role, active
  and billable state, `effective_at`, `recorded_at`, `source_operation`, actor
  (`auth.uid()` and kind), `db_transaction_id`, idempotency key.
- Billable = `active AND role IN ('owner','manager','staff')`. Pending invitations are
  not memberships. Unknown roles and inactive/revoked rows are not billable.
- A `BEFORE INSERT` guard makes an impossible interval unrepresentable even for a
  future writer: gapless sequence, non-decreasing time for captured changes, and
  per-user state continuity. Concurrent changes serialize on a per-shop advisory lock
  (and on the membership row lock / existing team lock).
- **Corrections** are explicit compensating events (`commercial_membership_correct`,
  service role only, idempotent, `CB409` on a changed replay). A correction sets one
  user's billable state from a recorded instant until the next recorded event; it
  must reference the event it corrects, lie inside coverage, and not be in the
  future. Nothing is ever updated or deleted.

Coverage starts **at the migration instant** (taken once, after the membership
table lock is held) with a snapshot of each existing shop's current memberships.
No history is invented from `created_at`, `revoked_at`, current role or the present
member count.

## Authority

Browser roles have no table access. `commercial_membership_read` is allowed for the
live active owner and the service role only; manager, staff, revoked, anonymous and
cross-shop callers get `42501`. Capture helpers and the correction writer are not
executable by browser roles (or by the service role, for the helpers). Append-only
holds for every role including the table owner (UPDATE/DELETE/TRUNCATE refused);
only the shop-deletion cascade removes rows.

## Proration rules (`computeSeatProration`)

- Half-open UTC period `[start, end)`, **midnight to midnight**; otherwise
  `period_not_utc_day_aligned`.
- A user billable at **any instant** of a UTC calendar day consumes one seat-day for
  that day; distinct users, never rows or events. An event exactly at midnight
  belongs to the new day.
- Per day, `extra seats = max(distinct billable users − included seats, 0)`
  (3 included).
- Period charge = `Σ extra seat-days × 3900 / days in period`, **rounded once,
  half-up**. The result carries the exact numerator and denominator, the rounded
  cents, per-day evidence and the event ids used.
- Unavailable (never zero), each with a code and, where there is one, the exact gap:
  `no_membership_evidence`, `membership_read_failed`, `malformed_membership_evidence`,
  `invalid_period`, `period_not_utc_day_aligned`, `no_coverage`, `coverage_gap`,
  `period_not_closed`.
- A period must be **closed as of the evidence instant** (`asOf ≥ period end`);
  otherwise later changes are not yet known.

## Invoice total

`subscription.invoiceTotal` is `available` only when base, seat proration **and**
usage are all available; any unavailable, conflicted or cap-refused component keeps
it `unavailable` with the reason. Usage lines are byte-for-byte unchanged by
membership evidence (tested). `readCommercialUsagePreview` keeps PR A behavior
(seats `no_membership_evidence`); `readCommercialPeriodPreview` reads both halves at
the same `as_of`.

## Limitations (deliberate, fail closed)

1. **Coverage begins at migration.** Earlier periods are `coverage_gap`; there is no
   backfill. The first fully-covered billing period starts at the first UTC midnight
   after the migration reaches production.
2. **Source operation is derived, not declared.** Events record the SQL operation
   (`membership_insert/update/delete`), the actor (`auth.uid()` / role) and the
   transaction id. They do not name the calling RPC, because direct trusted writes
   exist and the existing `team_*` functions were not rewritten.
3. **Micro-timing.** Instants are database `clock_timestamp()` values with microsecond
   precision; a change and its evidence are the same instant by construction.
4. **A same-instant change and revert** within one transaction is two events at
   distinct microseconds and is counted by the any-instant rule.
5. Open (in-progress) periods return `period_not_closed` rather than an estimate.
6. Cap, tax, dunning, trials, coupons and refunds remain out of scope.

## Follow-on

PR C Stripe platform customer/subscription state and Checkout at the first agent
activation boundary · D reviewed meter/event mapping and settlement · E signed
webhook reconciliation, dunning, portal links · F test-clock and sandbox acceptance.

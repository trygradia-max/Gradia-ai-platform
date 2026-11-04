# Claude handoff — commercial billing PR B

## Copy-paste prompt

```text
Implement Commercial Billing PR B only in this worktree:

/Users/harryhatch/Gradia/worktrees/claude-seat-proration

Branch: claude/billing-seat-proration

Read AGENTS.md completely and follow its required governing-document order. Then
read the approved commercial catalog, hybrid commercial model, production launch
plan, PR A architecture and implementation, every shop-membership migration/RPC,
team-permissions code/tests, billing-seats.ts and all current billing tests. Before
changing a Next.js file, read the relevant current node_modules/next/dist/docs guide;
prefer keeping PR B below the Next/UI layer.

GOAL

Replace PR A's `seat_proration_unavailable` with tenant-safe immutable membership
history and deterministic daily extra-operator seat proration. No Stripe call,
checkout, subscription, meter, webhook, deploy or production/shared-data change.

APPROVED RULES

- Founder Pilot/Core includes 3 billable operator seats.
- Active owner, manager and staff roles are billable operators.
- Pending invitations, inactive/revoked memberships, read-only access and unknown
  roles are not billable.
- Count distinct users, not membership rows.
- Additional seats are $39/month with daily proration.
- Use a half-open UTC billing period and calendar-day evidence. A user active at any
  instant during a UTC calendar day consumes one seat-day for that day; never count
  one user twice on one day.
- Per day, extra seats = max(distinct billable active users - included seats, 0).
- Aggregate all extra seat-days for the period, multiply by $39 / number of calendar
  days in that billing period, and round once to the nearest cent using half-up
  rounding. Return the exact numerator/denominator and rounded cents as evidence.
- Do not reconstruct historical membership from current state. Coverage before the
  first trustworthy snapshot/event is unavailable, never zero.

SCOPE

1. Audit every membership mutation path: shop bootstrap, invitation acceptance,
   owner/manager member changes, activation/revocation, role changes and any direct
   service-role path.
2. Add the smallest append-only tenant-bound membership billing event/snapshot
   contract. Preserve user/member identity, old/new billable role/state, effective
   time, source operation, actor/evidence and idempotency. Corrections are explicit
   append-only facts; never rewrite prior billing history.
3. Capture future membership changes atomically in the same database transaction as
   the membership mutation, including direct trusted writes. Do not let a failed
   membership mutation create billing evidence or vice versa.
4. Establish an explicit coverage start and initial active-membership snapshot at
   migration/activation time. Do not claim coverage before it. A preview that overlaps
   uncovered time returns `seat_proration_unavailable` with the exact gap.
5. Browser roles cannot insert/update/delete billing evidence. Owner reads use live
   authority; staff, managers, revoked, anonymous and cross-shop callers are refused.
6. Make capture/replay atomic and idempotent. Exact replay returns the existing event;
   changed replay conflicts. Concurrent role/active changes serialize with existing
   team locks/invariants and cannot create an impossible interval.
7. Extend the PR A deterministic preview so subscription seat proration becomes
   available only with complete coverage. Preserve usage calculations and failure
   semantics. Base + seat preview may be shown, but full invoice total remains
   unavailable wherever another required component is unavailable/conflicted.
8. Do not backfill a fake history from `created_at`, `revoked_at`, current role or the
   present member count. Document any existing historical limitation.
9. No public UI, checkout, Stripe IDs/API, Customer Portal, tax, trial, dunning,
   coupon, refund, live mode, provider activation or shared database mutation.

REQUIRED TESTS

- owner/manager/staff count when active; inactive/revoked/pending/unknown do not;
- distinct-user counting and no duplicate seat-day;
- included three seats produce zero extra-seat charge;
- mid-period activation, revocation, reactivation and role change calculate exact
  UTC seat-days and half-up rounding once per period;
- a same-day activate/deactivate counts one seat-day, not two;
- month lengths and half-open rollover boundaries are correct;
- incomplete history returns unavailable, never zero;
- membership mutation and billing-event capture commit/rollback atomically;
- exact replay, changed replay and concurrent mutation behavior;
- owner read, staff/manager/revoked/anonymous/cross-shop denial;
- browser table mutation denial and append-only owner/service probes;
- current PR A usage preview behavior remains unchanged;
- migration from zero and upgrade without rewriting existing memberships or PR A
  commercial usage evidence.

Run focused and full repository validation, including the disposable integration
suite and a purpose-built upgrade verifier. Actually run the verifier before asking
for merge. Append docs/AI_WORK_LOG.md, commit, push and open one PR against current
main with exact commands/results and limitations.
```

## Follow-on

PR C adds Stripe platform customer/subscription state and Checkout at the first
agent-activation boundary. It remains separate from this membership-history PR.

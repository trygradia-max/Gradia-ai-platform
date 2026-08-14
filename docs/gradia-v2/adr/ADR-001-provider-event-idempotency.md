# ADR-001 — Provider-Event Idempotency Mechanism

**Status:** accepted with conditions (Organizer review 2026-08-13, under explicit founder mandate — see Approval record below; conditions C1–C7 are binding on P0-005 close and on P0-006/007. **Condition status 2026-08-14:** C1, C2 and C7 — the P0-005-close conditions — are satisfied; **C3 is satisfied for the Twilio inbound route** (P0-006 done, PR #19) and remains binding on P0-007; C4, C5 and C6 remain open on their consumers. See the Condition status updates below)

## Context

D-023 requires every external provider event to be idempotent, enforced by
database constraints — never check-then-insert. The 2026-07-20 audit found the
discipline uneven:

- ✅ Stripe: `credit_grants.stripe_ref` partial unique + 23505-as-duplicate,
  `payments (shop_id, stripe_invoice_id)` unique upsert — the reference pattern.
- ✅ Voice call records: `call_records UNIQUE (shop_id, vapi_call_id)`.
- ❌ `usage_events`: no idempotency key at all — a retried Vapi end-of-call
  report double-bills voice minutes (audit doc 02 §Webhook flow; doc 05 §6).
- ❌ `automation_runs`: dedupe is a code-side check-then-insert with no unique
  index (admitted in-code near `agent-runtime.ts:427`) — overlapping cron
  invocations can double-fire, and under autopilot double-SEND.
- ❌ Inbound SMS/email: no event-id dedupe of any kind (P0-006 and the Aurinko
  follow-up will consume this ADR's mechanism).

The ticket requires ONE mechanism applied uniformly. The two candidate shapes:

**(a) Per-table unique keys on provider refs** — generalize the
`call_records`/`stripe_ref` pattern: every table that stores the result of a
provider event carries a unique index on the provider identifier; writers
insert-first and treat unique-violation (23505) as a clean duplicate.

**(b) A central `provider_events` claim table** — `(provider, event_id)`
unique; handlers insert-first ("claim") before doing any work, then mark the
claim completed/failed; duplicates and concurrent deliveries lose the claim
and exit with zero side effects.

## Decision

**Both shapes are the same principle (DB-constraint-enforced idempotency on
provider identifiers) applied at two different granularities, and each fits a
different event class. We adopt the rule, not a single table:**

1. **Single-row ledger events use per-table uniques (shape a).** Where one
   provider event produces exactly one durable row, the constraint lives on
   that row — no second bookkeeping structure to drift out of sync:
   - `usage_events`: partial unique `(shop_id, kind, vendor_ref) WHERE
     vendor_ref IS NOT NULL AND kind <> 'outreach_draft'` — kills
     double-metering (voice minutes, SMS segments, inbound classification,
     number rental). The `outreach_draft` exclusion exists because the
     recovery-extraction pipeline historically wrote many rows per job under
     one `vendor_ref = jobId`; those historical rows are legitimate distinct
     meterings (D-024 forbids rewriting them), so they cannot satisfy a
     unique. New extraction writes switch to per-row refs (`jobId:rowId`) so
     a follow-up can extend coverage once historical rows age out.
   - `automation_runs`: partial unique `(automation_id, trigger_ref) WHERE
     trigger_ref IS NOT NULL AND status <> 'failed'` — kills the double-fire
     race. `automation_id` is already tenant-scoped (`automations` is unique
     on `(shop_id, catalog_key)`), so tenants cannot collide. Excluding
     `'failed'` preserves today's semantics: a failed attempt never blocked a
     later retry (previously it simply left no row). Writers claim the run
     row FIRST (status `staged`), then stage/send, then transition the same
     row (`sent`/`failed`). This is a lifecycle state transition on one
     logical record, not a correction of history — financial ledgers remain
     strictly append-only; `automation_runs` status/pending-link updates are
     the explicit, documented exception to its append-only convention note.
   - Existing Stripe + `call_records` uniques stay as they are.

2. **Multi-table inbound webhook events use the central claim table
   (shape b).** One inbound SMS/email/end-of-call fans out into
   `interactions`, `customers`, `pending_actions`, consent fields, and LLM
   spend — there is no single natural row to hang a unique on, and wrapping
   the whole fan-out in one DB transaction would put LLM/vendor calls inside
   a transaction (forbidden). A claim table gives those handlers an
   insert-first gate with durable processing state:

   ```
   provider_events (
     id, provider, event_id, shop_id (nullable — tenant may be unresolved),
     status processing|completed|failed, attempts,
     first_seen_at, last_attempt_at, completed_at, failed_at,
     last_error (sanitized, truncated), metadata (safe keys only),
     UNIQUE (provider, event_id)
   )
   ```

   Lifecycle via three RPCs (service-role-execute only, row-lock serialized):
   - `claim_provider_event` — `INSERT … ON CONFLICT DO NOTHING`; if conflict,
     `SELECT … FOR UPDATE` and decide: `completed → duplicate_completed`
     (never reprocess); fresh `processing → duplicate_processing` (concurrent
     delivery loses); stale `processing` past a caller-supplied threshold →
     `reclaimed_stale` (a crashed instance cannot permanently strand an
     event — the provider's next retry takes the claim over); `failed →
     reclaimed_failed` (explicit retry-after-failure policy, attempts+1).
   - `complete_provider_event` / `fail_provider_event` — terminal marks;
     failure stores a sanitized, truncated error and stays observable.
   - Claims are made strictly AFTER signature verification (P0-006/007 wire
     this; the DB layer enforces that nothing without the service role can
     insert or execute the RPCs, so an unauthenticated sender can never
     poison a legitimate event id).

3. **Event-id namespacing contract:** `event_id` must be globally unique
   within its provider namespace. Twilio `MessageSid` and Vapi `call.id`
   qualify as-is; Aurinko message ids are per-account and MUST be prefixed
   (`<accountId>:<messageId>`) by the caller. Two providers can never collide
   (provider is part of the key); two tenants can never collide (provider ids
   are globally unique, or namespaced to be).

### Session-client ledger writes discovered (ticket failure-case resolution)

The RLS flip to SELECT-only exposed two legitimate session-client write paths
(the ticket pre-authorizes: "move to service-role or exempt"):

- `recordUsage` (`credits.ts`) is invoked with the RLS session client from
  five owner surfaces (agentic plans, whisper notes, BI answers, outreach
  drafts, in-app approval execution metering). **Moved to service-role inside
  `recordUsage`** — the one metering write path now writes with the service
  client (explicit `shop_id` scoping retained), falling back to the passed
  client only where service env is absent (unit tests). Exempting instead
  would have left owners able to INSERT negative-credit rows.
- `backfillStripePayments` (`app/actions/payments.ts`) upserts the `payments`
  mirror with the session client. **Moved to service-role** after the
  existing `requireUser`/`requireShop` auth, keeping the explicit shop scope.

With those moved, `usage_events`, `payments`, `shop_metrics` flip to
SELECT-only for owner sessions (the `credit_grants` pattern), closing audit
doc 05 weakness #4 (owner-writable ledgers) per D-024.

## Alternatives considered

- **Claim table for everything (pure b):** rejected — for single-row ledgers
  it duplicates state (claim row + ledger row) that can disagree, doubles
  storage per metering event, and adds an RPC round-trip to every
  `recordUsage`. The ledger row IS the receipt; a second one is drift risk.
- **Per-table uniques for everything (pure a):** rejected — inbound webhook
  fan-out has no single row to constrain; hanging the unique on
  `interactions` alone would leave classification spend, consent writes, and
  card staging unguarded, and end-of-call reports write N transcript rows.
- **In-memory/process dedupe (Set/Map, timing):** rejected outright —
  multiple Vercel instances, no durability (D-023 requires DB enforcement).
- **Queue/outbox:** explicitly deferred to P10 (ticket non-goal; security doc
  §8.4 accepts DB-unique idempotency as the bar until then).

## Consequences

- P0-006 (Twilio) and P0-007 (Vapi) consume `claim_provider_event` /
  `complete` / `fail` via `src/lib/provider-events.ts`; they add no schema.
- `provider_events` grows unboundedly until a pruning cron lands — noted as a
  follow-up ticket (per the P0-005 non-goal); at pilot scale (hundreds of
  events/day) this is years of headroom.
- Duplicate suppression is a normal outcome: info log
  `[idempotency] duplicate <provider>:<ref> ignored`, never an error
  (P0-012's metrics will count these).
- The `outreach_draft` exclusion on the `usage_events` unique is a documented
  coverage gap for one non-provider SKU; follow-up ticket extends coverage
  once per-row refs are the only historical shape.
- Owner sessions lose (never-legitimate) PostgREST write access to the three
  ledgers; owner-facing reads are unchanged.

## Approval record (Organizer, 2026-08-13)

**Verdict: APPROVED WITH CONDITIONS.**

Reviewed against the P0-005 ticket, `02-target-architecture.md`,
`08-security-and-reliability.md` §3–4, `09-testing-strategy.md`,
`11-decision-log.md` (D-023/D-024), the P0-004/P0-004A architecture
(advisory-lock + partial-unique idempotency pattern this ADR generalizes),
and the current webhook/provider routes. Examination of the mandated points:

- **`(provider, event_id)` as the global receipt key — correct.** Provider
  ids are globally unique per namespace or namespaced by contract; adding
  `shop_id` to the key would fragment claims whenever tenant resolution
  fails, re-opening the duplicate window. The namespacing contract is
  documentation-enforced, not schema-enforced — accepted, with C4 pushing it
  into the Aurinko consumer's spec.
- **Unresolved-tenant events — correct.** Nullable `shop_id` keeps dedupe
  intact when resolution fails (the alternative — refusing the claim —
  would loop the provider retry forever); tenant backfill on reclaim is
  proven by test.
- **Failed/stale reclaim — correct.** Failure is durable + observable;
  provider retries reclaim it (explicit `retry_failed` policy); stale
  takeover (default 300s) prevents crash-stranding. Attempts are unbounded
  but provider retry schedules are finite; repeat-failure visibility lands
  with P0-012. One edge: the Vapi route exports no `maxDuration` (platform
  default up to 300s = the stale default) — C5.
- **Authentication-before-claim — correct and enforced at two layers.**
  DB layer: deny-all RLS + EXECUTE revoked from anon/authenticated, proven
  by poisoning tests (forged/anon/owner-session callers cannot reserve a
  real event id, and the legitimate event stays claimable). Route layer is
  a caller contract — C3 makes the ordering tests binding in P0-006/007
  (already in their specs).
- **Retention/pruning — accepted as deferred** (explicit ticket non-goal);
  C2 requires the follow-up ticket to exist before P0-006 starts writing
  volume. Pilot-scale growth gives years of headroom.
- **Ledger RLS SELECT-only — approved.** Closes audit doc 05 weakness #4
  per D-024; owner reads intact (permission tests); the two discovered
  session-client writers were moved to service-role rather than exempted —
  the correct branch of the ticket's failure case (an INSERT exemption
  would have preserved the negative-credit self-grant hole). The
  `recordUsage` unit-test fallback to the passed client is acceptable:
  in production the service env is a hard prerequisite of every webhook.
- **P0-005 vs P0-006/007 separation — clean.** The diff wires no route,
  touches no Twilio/Vapi/Aurinko handler, and adds no provider semantics;
  the claim helper is dormant until its consumer tickets land.
- **`outreach_draft` exclusion — acceptable as a temporary exception.**
  D-024 forbids rewriting the historical jobId-ref rows, so exclusion is
  the only compliant shape; per-row refs are already flowing. C6 time-boxes
  it and bars silent widening of the exclusion list.
- **`automation_runs` lifecycle updates** (staged → sent/failed on the one
  claim row) are an explicit, documented exception to that table's
  append-only convention note; financial ledgers remain strictly
  append-only. Acceptable — status fidelity feeds ROI/owner surfaces.

**Conditions (binding):**

- **C1 — Independent review still required.** This Organizer review ran in
  the same session that built P0-005 (founder-directed; recorded). It does
  NOT satisfy the one-role-per-session rule's intent for diff review: the
  Cursor Reviewer's independent verification against the ticket +
  `12-definition-of-done.md` remains a hard gate before done.
- **C2 — Retention follow-up ticket** for `provider_events` pruning must be
  filed in the backlog before P0-006 enters implementation.
- **C3 — Route-level claim-after-verify ordering** must be test-locked in
  P0-006 and P0-007 (forged request never creates a claim), extending
  `eval/webhooks.test.ts` rather than parallel-tracking it.
- **C4 — Aurinko namespacing:** the Aurinko dedupe ticket must specify
  `accountId:`-prefixed event ids explicitly in its scope.
- **C5 — Vapi stale threshold:** P0-007 must set an explicit route
  `maxDuration` and pass a `staleAfterSeconds` strictly above it (the
  300s default equals the platform-default ceiling — reclaim-while-running
  must be impossible by construction).
- **C6 — `outreach_draft` exclusion is time-boxed:** a follow-up ticket
  extends the unique to `outreach_draft` (e.g. created_at-cutoff partial
  predicate) once historical refs age out; no new kind joins the exclusion
  list without amending this ADR.
- **C7 — Production duplicate audit before production migration:** the
  founder runs the read-only duplicate-audit queries against production;
  a nonzero result on a financial table pauses rollout per D-024 (rows are
  never deleted silently).

Program boards intentionally NOT updated — P0-005 remains **in-review**
pending C1 and C7.

## Condition status update (docs-close session, 2026-08-13)

P0-005 merged to `main` in PR #17 (`e1dedfb`). Condition disposition:

- **C1 — SATISFIED.** Independent Cursor review completed: verdict
  **APPROVE**, no BLOCKER or HIGH code defects.
- **C2 — SATISFIED.** Retention/pruning follow-up filed as
  `../tickets/P0-005A-provider-events-retention-pruning.md` (2026-08-13,
  before P0-006 enters implementation).
- **C7 — SATISFIED.** Founder ran the read-only duplicate-audit queries
  against production: `usage_events (shop_id, kind, vendor_ref)` excluding
  `outreach_draft`/null refs → zero rows; `automation_runs (automation_id,
  trigger_ref)` excluding `failed`/null refs → zero rows. No financial rows
  touched.
- **C3, C4, C5, C6 — OPEN, unchanged.** They bind P0-006 (C3), the Aurinko
  dedupe ticket (C4), P0-007 (C3, C5), and the `outreach_draft` follow-up
  (C6). P0-006/007 have not started.

P0-005 is **done** (close record in the ticket file); the staging manual
acceptance run remains outstanding and gates full rollout acceptance of the
production migrations — tracked in the ticket's close record, not as an ADR
condition.

## Condition status update (docs-close session, 2026-08-14 — P0-006 close)

P0-006 merged to `main` in PR #19 (`76847e4`). Condition disposition:

- **C3 — SATISFIED for the Twilio inbound route.** The route claims
  `(provider='twilio', event_id=MessageSid)` strictly after server-side
  credential/shop resolution + signature verification and strictly before
  any write or LLM call; forged/missing-signature requests can never claim
  or poison a MessageSid. Test-locked by extending `eval/webhooks.test.ts`
  (not parallel-tracked) plus the DB-backed
  `eval/integration/twilio-inbound-replay.int.test.ts` suite, per this
  condition's terms. **C3 remains binding on P0-007** (the Vapi route).
- **The stale-threshold discipline C5 formalizes for Vapi held on this
  route:** the Twilio inbound route's `maxDuration` (60s) is strictly below
  the provider_events stale threshold (300s) — reclaim-while-running is
  impossible by construction. C5 itself remains open on P0-007.
- **C4 (Aurinko namespacing), C6 (`outreach_draft` time-box) — OPEN,
  unchanged.**

Route-level evidence beyond the conditions (recorded in the ticket close
record): the durable receipt is `provider_events` alone — no
Twilio-specific duplicate table and no new migration, exactly as this ADR's
Consequences predicted; the P0-005 `usage_events` unique (MessageSid as
`vendor_ref`) acts as defense-in-depth behind the claim; and `recordUsage`
now surfaces `written`/`duplicate`/`failed` so a caller that needs durable
metering (the Twilio inbound path) can fail the provider event and retry
instead of silently completing without a usage row. One accepted residual:
a provider retry after a genuine metering-write failure may re-run the
classifier (output not persisted) — non-blocking; optional optimization
only if future cost/reliability data justifies it.

## Links

P0-005 (this ticket) · P0-006 / P0-007 (consumers) · D-023 / D-024
(`../11-decision-log.md`) · `../08-security-and-reliability.md` §3–4 · audit
docs 02 §Webhook flow, 05 §Schema weaknesses #4/#6 · `rate_limits` deny-all
RLS pattern (`supabase/migrations/20260615120000_rate_limits.sql`) ·
`call_records` unique (`20260702120000_glass_box_capture.sql`).

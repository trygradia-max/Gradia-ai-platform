# ADR-001 — Provider-Event Idempotency Mechanism

**Status:** proposed (Builder, 2026-08-12, during P0-005 — awaiting Organizer approval per the ticket's internal gate)

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

## Links

P0-005 (this ticket) · P0-006 / P0-007 (consumers) · D-023 / D-024
(`../11-decision-log.md`) · `../08-security-and-reliability.md` §3–4 · audit
docs 02 §Webhook flow, 05 §Schema weaknesses #4/#6 · `rate_limits` deny-all
RLS pattern (`supabase/migrations/20260615120000_rate_limits.sql`) ·
`call_records` unique (`20260702120000_glass_box_capture.sql`).

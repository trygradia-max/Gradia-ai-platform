# P0-005A — provider_events retention and pruning

- **Ticket ID:** P0-005A
- **Epic:** E00 — Stabilization
- **Status:** **ready** (filed 2026-08-13 at the P0-005 close, satisfying **ADR-001 condition C2** — this ticket must exist before P0-006 enters implementation; unscheduled — the Organizer sequences it. Pilot-scale growth gives long headroom, but pruning must land before P0-006/P0-007 receipt volume makes the table operationally significant)
- **Priority:** Medium (hygiene/limits, not a live correctness gap; becomes High if P0-006/007 volume outpaces sequencing)

## Objective

Bound the growth of the `provider_events` claim table (created by P0-005, migration `20260812120000_webhook_idempotency.sql`). The table is append-per-event by design and currently grows unboundedly (accepted as deferred in ADR-001 §Consequences); this ticket adds a retention window and a pruning job so idempotency receipts do not accumulate forever.

## User outcome

None owner-visible. Operationally: the claim table stays small enough that claims, reclaim scans, and backups remain fast at any tenant count; storage does not grow without bound.

## Current code references

- `supabase/migrations/20260812120000_webhook_idempotency.sql` — `provider_events` table + `claim/complete/fail_provider_event` RPCs (deny-all RLS, service-role-only EXECUTE).
- `src/lib/provider-events.ts` — the claim helper P0-006/007 consume.
- `docs/gradia-v2/adr/ADR-001-provider-event-idempotency.md` — §Consequences (unbounded growth noted; pruning is the named follow-up) and condition **C2**.

## Exact scope

1. **Retention policy decision (in-ticket, Organizer-approved):** how long a `completed` receipt must survive to keep dedupe meaningful. The floor is the longest provider retry horizon (Twilio/Vapi/Aurinko retry schedules) plus a safety margin; propose a concrete window (e.g. 30–90 days for `completed`) and a longer window for `failed` rows (they are the observability trail until P0-012 metrics land).
2. **Pruning job:** a service-role scheduled job (existing cron pattern) deleting `completed` rows older than the retention window, batched/bounded per run so it can never monopolize the DB. `failed` rows prune on their own longer window; `processing` rows are NEVER pruned by age alone (stale-reclaim semantics own them).
3. **Observability:** info-level log per run (rows pruned, oldest remaining), feeding P0-012 later.
4. **Optional hardening (fold in if cheap, else split):** bounds on `metadata` size and an `attempts` sanity cap surfaced as a warning — the "metadata/attempt bounds" hardening noted at the P0-005 close.

## Explicit non-goals

- No archival/export of pruned receipts (nothing downstream consumes them).
- No change to claim/complete/fail semantics or the `(provider, event_id)` key.
- No queue/outbox (P10/E10).

## Dependencies

P0-005 (done 2026-08-13). ADR-001 (accepted with conditions). No founder decision required beyond Organizer approval of the retention window (falls under ADR-001's accepted design; escalate only if a compliance retention need surfaces).

## Expected modules affected

New cron route or scheduled job entry (existing `/api/cron` pattern); possibly a small SQL function for the batched delete; no changes to `provider-events.ts` claim paths.

## Database impact

Row deletion within retention policy only. Possibly one small migration if a delete-batch SQL function is added (additive). No index/schema changes expected — the existing `first_seen_at`/status columns suffice; add an index only if the delete plan proves it necessary.

## Migration impact

Zero or one additive migration (delete-batch function). Not expected to occupy the DB-sensitive WIP slot unless a migration is actually written — confirm at slotting.

## API / UI / Permission impact

None. Job runs service-role; no owner surface.

## Tenant-isolation impact

Pruning is time/status-keyed, not tenant-keyed; deletes must remain blind to tenant (no shop-scoped retention differences in this ticket).

## Idempotency / Observability / Analytics requirements

The job itself must be idempotent and overlap-safe (two concurrent runs must not error — bounded batches + stable ordering). Per-run info log (counts). No analytics.

## Feature flag

None — operational hygiene job; the retention window constant is the control.

## Automated tests

- Integration: seed `completed`/`failed`/`processing` rows across ages → one run prunes exactly the expired `completed`/`failed` rows, never `processing`, never in-window rows.
- Overlap: two concurrent runs → no error, no double-count.
- Replay safety: after pruning an old `completed` receipt, a re-delivered ancient event id is treated as new — test documents this as the accepted retention tradeoff (window ≥ provider retry horizon makes it unreachable in practice).

## Manual acceptance procedure

1. On staging, seed aged rows; trigger the job; verify counts and that in-window rows survive.
2. Verify the cron schedule is registered and the run logs appear.

## Failure cases

- Job failure → rows accumulate (safe direction); next run catches up. No partial-delete corruption possible with bounded single-statement batches.
- Retention window set below a provider's retry horizon → duplicate window reopens for ancient retries; guarded by the policy floor in scope item 1.

## Rollback strategy

Disable the cron entry. Deleted receipts are not recoverable — which is why the window floor is the provider retry horizon plus margin, and why `processing` is never age-pruned.

## Definition of done

All of `../12-definition-of-done.md` plus: retention windows documented in this file and in ADR-001 (addendum, not a rewrite); job live on staging with a verified run; tests above green in the integration tier.

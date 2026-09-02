# P0-005A — provider_events retention and pruning

- **Ticket ID:** P0-005A
- **Epic:** E00 — Stabilization
- **Status:** **ready** (filed 2026-08-13 at the P0-005 close, satisfying **ADR-001 condition C2** — this ticket must exist before P0-006 enters implementation; unscheduled — the Organizer sequences it. Pilot-scale growth gives long headroom, but pruning must land before P0-006/P0-007 receipt volume makes the table operationally significant. **Note 2026-08-14 at the P0-007 close: both consumer routes — Twilio inbound (P0-006, PR #19) and Vapi end-of-call (P0-007, PR #21) — are now live and writing receipts; this ticket remains open and the sequencing pressure is now real, not hypothetical.**)
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

---

## Retention policy + implementation record (Builder, 2026-09-01 — autorun Batch 1, item 2, branch `auto/batch-1`)

_Status line above is the Organizer's to flip. This section satisfies the DoD item "retention windows documented in this file"; the ADR-001 addendum of the same date mirrors it._

**Retention policy (scope item 1 — proposed by the Builder under the ticket's in-ticket delegation; Organizer ratifies at closeout):**

| Status | Window | Enforced where |
|---|---|---|
| `completed` | **30 days** (default) | `prune_provider_events` default + `PROVIDER_EVENT_RETENTION.completedDays` |
| `failed` | **90 days** (default) — the observability trail until P0-012 metrics land | same |
| any terminal | **floor 7 days** — clamped inside the SQL function; no caller can go lower | `GREATEST(…, 7)` in the migration; test-locked |
| `processing` | **never by age** — stale-reclaim semantics own them | `processing` appears in no DELETE predicate; test-locked (unit + integration) |

Floor rationale: the longest provider webhook retry horizon in the stack is Stripe's (~3 days); Twilio, Vapi and Aurinko retry for minutes-to-hours. 7 days ≥ 2× the longest horizon; 30 days = 10×. Once a receipt outlives its provider's retry window that provider can no longer re-deliver the event, so pruning it cannot reopen a duplicate — the accepted tradeoff, documented by an integration test ("after pruning, an ancient event id claims as new").

**Mechanism (scope items 2–3):** migration `supabase/migrations/20260901120000_provider_events_pruning.sql` — one additive partial index `provider_events_completed_prune_idx (completed_at) WHERE status = 'completed'` (the existing status index deliberately excludes completed rows, which are the bulk of the table) and one service-role-only RPC `prune_provider_events(p_completed_retention_days, p_failed_retention_days, p_batch_size)` that deletes at most `p_batch_size` expired rows per terminal status per call, oldest-first, via `LIMIT … FOR UPDATE SKIP LOCKED` (two concurrent runs take disjoint rows — no error, no double count), and returns a jsonb report. `src/lib/provider-events-retention.ts` holds the constants and the bounded run loop (up to 10 batches × 5,000 rows, stops on the first partial batch); `src/app/api/cron/provider-events-prune/route.ts` is the daily cron (`vercel.json` `30 4 * * *`, `CRON_SECRET` bearer, fails closed, 500 on DB error — rows accumulate, the safe direction). One info line per run: batches, pruned counts, expired remaining, oldest surviving completed/failed, processing rows, retention/batch settings. `src/lib/provider-events.ts` (claim paths) untouched.

**Hardening (scope item 4, folded in as surfacing only):** the report counts `attempts > 25` and `pg_column_size(metadata) > 4096` rows; the cron logs a WARN line for each non-zero count. Enforcing CHECK constraints was **split** (a `NOT VALID` + `VALIDATE` pair on a live table is a separate, reviewable change) — residual below.

**Evidence:** migration applied to the local stack and re-applied via the container's `psql` with no error (`IF NOT EXISTS` notice only); `EXPLAIN` on 30,000 synthetic completed rows (inserted and rolled back in one transaction) shows `Index Scan using provider_events_completed_prune_idx` under `LockRows` → `Limit`, and one call pruned exactly 5,000 leaving 24,280 expired; integration suite `eval/integration/provider-events-prune.int.test.ts` (6 tests, real Postgres): exact expired set pruned, `processing`/in-window survive, 7-day floor clamp, bounded oldest-first batches + catch-up, two concurrent runs on separate connections split 40 rows exactly, pruned ancient id claims as new, anon cannot execute the RPC; unit suite `eval/provider-events-prune.test.ts` (15 tests): policy floors, cron auth fail-closed with zero DB calls, batch loop + cap, 500 on error, log/warning lines, vercel.json registration, migration structure locks. `eval/tenant-scoping.test.ts` `REVIEWED_IMPORTERS` extended with the new route (tenant-blind by spec: its only query is the RPC).

**Manual acceptance:** step 1 (seed aged rows → run → counts, in-window survive) **executed locally** by the integration suite and the rolled-back 30k-row run above; step 2 (schedule registered, run logs appear) — registration **executed** (unit-locked in `vercel.json`), the first real scheduled run and its log line on **staging/Preview are assigned to the founder** (Lane A) after the batch deploys — the ticket is held out of *done* until that confirmation.

**Residuals:** LOW — enforce metadata/attempt bounds as CHECK constraints (split from item 4); LOW — the per-run hardening counts are one sequential scan of the (now bounded) table, acceptable at retained scale, revisit if the table ever exceeds ~1M rows; LOW — `prune_provider_events` is callable with any window ≥ 7 days by any service-role caller — the cron always passes the constants; a future policy change is a constant edit + this record.

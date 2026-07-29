# P0-007 — Vapi transcript and usage replay protection

## Ticket ID
P0-007

## Epic
E00 — Stabilization

## Status
**Draft** — becomes **ready** when P0-005 (webhook event idempotency foundation) is done. This ticket consumes the dedupe pattern/foundation P0-005 establishes; do not start it before P0-005 merges.

## Priority
P0 — High. Double-billing customers for voice minutes is a financial-integrity defect (D-024) and occurs under *normal* provider retry behavior, not an edge case.

## Objective
Make the Vapi end-of-call report processing fully idempotent: a redelivered end-of-call webhook must produce zero additional transcript `interactions` rows and zero additional voice-minute `usage_events`, matching the idempotency `call_records` already has.

## User outcome
A shop owner is never billed twice for the same call, and a call's transcript never appears duplicated in the customer timeline or shared memory — regardless of how many times Vapi retries its webhook.

## Current code references
- Audit trace H (`docs/audit/04-workflow-traces.md` §H): "end-of-call report is NOT idempotent outside call_records — a Vapi retry duplicates transcript rows and **double-meters voice minutes** (no vendor_ref uniqueness on `usage_events`)."
- `call_records` upsert is already idempotent on UNIQUE `(shop_id, vapi_call_id)` (`docs/audit/05-database-audit.md`) — this is the pattern to extend.
- `usage_events` has **no idempotency key** (`docs/audit/05-database-audit.md` §Billing/metering; schema weakness #6).
- Transcript turns are written into `interactions` at end of call (audit trace H; `docs/audit/07-ai-architecture-audit.md` §Memory).
- `VAPI_DEFAULT_SHOP_ID` fallback routes unmatched assistants to that shop — "must be unset in prod" (audit trace H).
- Webhook auth (per-shop `x-vapi-secret`, timing-safe) is already sound (`docs/audit/06-security-and-tenancy-audit.md` route matrix) — not in scope.

## Exact scope
1. **Voice-minute metering idempotency:** every voice-minute `usage_events` insert from the Vapi webhook carries the provider event identifier (`vapi_call_id`) as its `vendor_ref`, and a uniqueness guarantee (unique index scoped per P0-005's chosen mechanism, e.g. partial unique on `(shop_id, kind, vendor_ref)` for voice kinds) makes replays no-ops. Insert path handles conflict gracefully (no thrown error, no duplicate).
2. **Transcript idempotency:** end-of-call transcript writes into `interactions` are deduplicated by `vapi_call_id` (per P0-005 foundation: either a dedupe key on the rows or a processed-event check keyed on the call id before writing turns). Replaying the same end-of-call report writes zero new interaction rows.
3. **Whole-handler replay safety:** the end-of-call branch of `/api/vapi/webhook` becomes replay-safe as a unit — budget checks, `vapi_stale` transitions, and `call_records` upsert must not double-fire side effects on redelivery.
4. **`VAPI_DEFAULT_SHOP_ID` code-side guard:** the fallback is refused when running in production (fail closed + structured log) so an unmatched assistant can never silently route calls/metering to the default shop in prod. (The *operational* verification that the var is unset in the Vercel prod env stays in P0-010's founder checklist — this ticket owns only the code guard.)

## Explicit non-goals
- No changes to Vapi signature verification or shop resolution (already sound).
- No changes to voice pricing, credit values, or metering *amounts* — only duplicate prevention.
- No backfill/cleanup of historical duplicate rows (if any exist in prod, that is a founder-approved data fix outside this ticket; document findings in the completion report).
- No reconciliation-cron changes beyond what duplicate-prevention requires.
- Twilio/Aurinko/Stripe webhook idempotency (P0-005/P0-006 territory).
- No post-call quote verifier or transcript-quality work (roadmap P9).

## Dependencies
- **P0-005** — webhook event idempotency foundation (mechanism + conventions this ticket applies to Vapi events).
- Decision status: no open founder decisions block this ticket.

## Expected modules affected
- `src/app/api/vapi/webhook/route.ts` (end-of-call branch)
- The metering/credits write path used by the webhook (`usage_events` insert helpers, e.g. the `recordUsage`-style module identified in audit doc 09)
- `src/lib/memory.ts` call sites for transcript writes (guarded, not rewritten)
- New migration under `supabase/migrations/`
- Tests under the existing deterministic eval/test tier

## Database impact
- Unique index enforcing voice-metering idempotency on `usage_events` (shape per P0-005 convention; must be partial/scoped so it does not collide with non-vendor event kinds that legitimately lack `vendor_ref`).
- Whatever dedupe structure P0-005 standardized for inbound events (e.g. processed-events table) gains Vapi rows.
- No destructive change; additive only. `usage_events` remains append-only (D-024).

## Migration impact
- One additive, idempotent migration (unique index / dedupe rows). Must be written to succeed on a database that already contains duplicate `(shop_id, vendor_ref)` voice rows — if pre-existing duplicates would break index creation, the migration must detect and fail with a clear message rather than half-apply, and the completion report must flag the founder data-fix decision. Migration test required.

## API impact
- No new endpoints. `/api/vapi/webhook` response behavior unchanged from Vapi's perspective (still 2xx on replays — a replay is a success, not an error).

## UI impact
- None. (Call records page already renders idempotently-upserted rows.)

## Permission impact
- None. Webhook remains service-role with per-shop secret verification.

## Tenant-isolation impact
- All new queries/writes carry explicit `shop_id` scoping (service-role path — code-discipline rules apply; see P0-011).
- The production guard on `VAPI_DEFAULT_SHOP_ID` removes a cross-tenant misrouting footgun (calls from unmatched assistants landing in another shop's data).

## Security impact
- Positive: eliminates a financial-integrity hole (double-billing) and a prod misrouting footgun. No new attack surface.

## Idempotency requirements
- Replaying an identical end-of-call payload N times ⇒ exactly one set of transcript `interactions`, exactly one voice-minute `usage_events` row (per metered unit), exactly one `call_records` row, and identical `vapi_stale`/budget side-effect state as a single delivery.
- Idempotency is enforced by **database constraint** (D-023: provider event identifiers, DB-enforced), not check-then-insert alone.

## Observability requirements
- Structured log line when a replay is detected and skipped (module-prefixed, includes `shop_id`, `vapi_call_id`, which write was skipped).
- Structured error (surfaced per P0-012 conventions once available) when the prod `VAPI_DEFAULT_SHOP_ID` guard rejects a call.

## Analytics requirements
- None (internal reliability fix; no product analytics events).

## Feature flag
**None — fix.** Justification: this corrects incorrect billing/data behavior; there is no state in which the old behavior is desirable, and the change is exercise-safe (replays simply become no-ops). Rollback is by revert, not flag.

## Automated tests
- **Idempotency replay tests:** deliver the same end-of-call fixture twice (and out-of-order/concurrently where the harness allows) → assert single transcript set, single metering row, single call_record.
- **Unit tests:** vendor_ref stamping on voice usage inserts; conflict-handling path returns success without duplicate.
- **Failure-path tests:** dedupe-store lookup failure fails closed (no double-write, webhook returns retryable status per P0-005 convention); prod guard on `VAPI_DEFAULT_SHOP_ID` refuses fallback.
- **Tenant-isolation test:** replayed event for shop A creates nothing visible to shop B; unmatched assistant in prod-mode creates nothing at all.
- **Migration test:** migration applies cleanly on empty and on populated schema (via the integration tier un-quarantined in P0-002/P0-005 sequencing).

## Manual acceptance procedure
1. On a seeded staging shop with voice configured, place (or simulate via captured fixture) one call; confirm one call record, one transcript set in the customer timeline, one voice-minute usage row with `vendor_ref = vapi_call_id`.
2. Re-POST the captured end-of-call payload to `/api/vapi/webhook` with valid signature headers.
3. Confirm: no new `interactions` rows, no new `usage_events` rows, credit balance unchanged, webhook returned 2xx.
4. Re-POST a third time after 5 minutes; same assertions.
5. Set `VAPI_DEFAULT_SHOP_ID` in a staging env flagged as production-mode; deliver an end-of-call for an unknown assistant; confirm the request is refused with a structured log and no rows written anywhere.
6. Confirm the reconciliation report for the period shows no drift introduced by the change.

## Failure cases
- Dedupe lookup/store unavailable → fail closed (retryable error to Vapi; no partial writes).
- Payload missing `vapi_call_id` → reject with structured error (never meter an event with no provider identifier — D-023).
- Pre-existing prod duplicates block the unique index → migration halts loudly; founder decision on cleanup.
- Concurrent duplicate deliveries → DB constraint is the arbiter; loser handles conflict as success-noop.

## Rollback strategy
- Code: revert the PR. The unique index may remain in place safely (it only prevents duplicates the old code shouldn't have created); if the index itself must be removed, a down migration dropping it is included in the PR description but is not auto-run.
- No data rollback needed — the ticket only prevents writes, never mutates existing rows.

## Definition of done
Per `12-definition-of-done.md`, plus ticket-specific: all automated tests above green in CI (including the replay suite), manual acceptance steps 1–6 recorded with evidence, completion report notes whether prod duplicate rows were detected, and reviewer confirms no scope creep beyond the Vapi event surface.

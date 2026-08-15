# P0-007 — Vapi transcript and usage replay protection

## Ticket ID
P0-007

## Epic
E00 — Stabilization

## Status
**done** (2026-08-14 — merged to `main` in PR #21, commit `8a4d4d1`; independent Cursor verdict **APPROVE**, no BLOCKER or HIGH findings, no review-fix commit required; founder acceptance run **PASSED** on isolated local staging; ADR-001 C3 and C5 satisfied for the Vapi route; close record at the end of this file. Prior state: blocked until the `docs/close-p0-006` closeout landed — resolved by `def97ab` PR #20, after which implementation proceeded.)

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

## Close record (docs-close session, 2026-08-14)

**Merged:** PR #21 → `main` as `8a4d4d1` ("fix: harden Vapi replay and
metering"), 2026-08-14.

**Review evidence:** independent Cursor verdict **APPROVE**; **no BLOCKER or
HIGH findings**; **no review-fix commit was required**.

### Final architecture (as merged)

- The end-of-call-report branch of `/api/vapi/webhook` now consumes the
  P0-005 `provider_events` mechanism — exactly as this ticket required, no
  second mechanism invented. Claimed identity: **`provider='vapi'`,
  `event_id=call.id`, for the end-of-call-report event only.**
- **Authentication occurs before claim** (ADR-001 C3, satisfied for this
  route): the per-shop `x-vapi-secret` verification runs strictly before any
  `provider_events` claim; a forged request can never claim or poison a
  call id.
- **Transcript replay is idempotent:** a redelivered end-of-call report
  writes zero new `interactions` rows.
- **voice_minute metering is doubly protected:** the `provider_events` claim
  plus the durable P0-005 `usage_events` unique (`vapi_call_id` as
  `vendor_ref`). A `recordUsage` failure on this path is
  **retryable/fail-closed** — the provider event fails and Vapi's retry
  reprocesses, rather than completing without a usage row (the P0-006
  `written`/`duplicate`/`failed` contract).
- **Completed events never reopen; stale reclaim converges safely.** Route
  `maxDuration=60` with the `provider_events` stale threshold at `300`
  seconds — `staleAfterSeconds` strictly above `maxDuration`, so
  reclaim-while-running is impossible by construction (**ADR-001 C5
  satisfied**).
- **Production `VAPI_DEFAULT_SHOP_ID` fallback now fails closed** for
  unmatched assistants (HTTP 404, structured refusal, zero writes). The
  operational verification that the var is unset in the Vercel prod env
  remains P0-010's founder checklist item, per this ticket's scope note.
- **No new migration was required** — the spec's expected migration
  (`usage_events` vendor_ref unique) had already landed in P0-005; this
  reconciles the ticket's pre-P0-005 "Database impact / Migration impact"
  sections, exactly as the WIP board's slotting note anticipated. The
  DB-sensitive WIP slot was never occupied.
- P0-008 (status callbacks) was not touched. Production conflict
  enforcement remains **OFF**.

### Founder acceptance — PASS (isolated local staging, 2026-08-14)

Environment: isolated local staging only — local Supabase, seeded P0-007
test shop, no production customer traffic, no Production Vercel config
changed, production conflict enforcement OFF throughout. Evidence:

1. **First delivery:** HTTP 200 `{ok:true, turnsIngested:3}`; one
   `provider_events` receipt (`provider=vapi`, `status=completed`,
   `attempts=1`); one three-turn final transcript; one `voice_minute` usage
   row (`duration_seconds=150`, billed quantity 3 minutes); one
   `call_records` row; budget under threshold.
2. **Replay #1:** HTTP 200 `duplicate:true`; zero additional receipt,
   transcript, usage, call-record, or financial/budget deltas; attempts
   remained 1.
3. **Replay #2:** same result, zero deltas.
4. **Post-restart durability replay:** new server process, replay more than
   300 seconds after original completion → still `duplicate:true`; the
   completed provider receipt did not reopen; all counts unchanged —
   durable Postgres idempotency, not in-memory dedupe.
5. **Financial reconciliation:** exactly one logical voice call, exactly one
   `voice_minute` ledger row (quantity=3), no duplicate `vendor_ref`,
   billed minutes match call duration, no message-credit deduction, no
   doubled budget effect, zero unexplained financial drift; no financial
   records were altered or deleted to make acceptance pass.
6. **Production fallback guard:** isolated local server with
   `VERCEL_ENV=production` and a non-empty staging/test
   `VAPI_DEFAULT_SHOP_ID`; unmatched assistant delivered → HTTP 404 "Shop
   not configured"; the production fallback explicitly refused; zero
   `provider_events`, transcript, usage, call_records, or customer rows;
   zero writes to the fallback shop; real Production untouched.
7. **Global reconciliation:** zero duplicate `(provider, event_id)`
   receipts; zero duplicate metering vendor_refs; zero duplicate
   call_records; zero duplicate transcript turns.
8. **Security/cleanliness:** no secrets exposed; no repo files changed
   during acceptance; clean git status; temporary test processes stopped;
   production conflict enforcement remains OFF.

### Accepted residuals (Cursor-recorded, non-blocking)

1. **Cross-tenant global call-id griefing:** an authenticated malicious
   tenant with knowledge of another shop's opaque Vapi `call.id` could
   pre-claim the global `(provider, event_id)` receipt, causing
   denial/under-billing — never cross-tenant mutation or disclosure. This
   is an accepted ADR-001 residual of the global-key design, not a P0-007
   merge blocker; mitigation follow-up recorded in `../program/backlog.md`.
2. **Vapi tool-call/function-call replay:** end-of-call is protected, but
   synchronous tool-call/function-call events are not replay-deduped —
   independently confirmed outside P0-007 scope; follow-up in the backlog
   (kept separate from P0-008).
3. **`call_records` remains best-effort** — potential loss is non-financial
   and accepted under the current ticket/DoD.
4. **Count-based transcript resume** assumes a provider retry carries the
   same ordered final report.
5. **`maxDuration=60`** may deserve future review if real end-of-call
   processing approaches that ceiling.

### Follow-ups recorded at close (Organizer sequences)

1. **Vapi tool-call/function-call replay protection** — investigate the
   provider `toolCallId` as a stable idempotency identity;
   captureLead/proposeBooking staging must not duplicate under provider
   retry. Separate from P0-008.
2. **Cross-tenant provider-event griefing mitigation** — emit a security
   warning when a duplicate claim's stored shop differs from the
   authenticated shop; evaluate per-provider tenant-safe namespacing where
   the tenant is deterministically resolvable; preserve ADR-001's
   global-key reasoning.
3. **P0-005A** provider_events retention/pruning remains open — both
   consumer routes (Twilio inbound, Vapi end-of-call) are now writing
   receipts.
4. Optional: revisit `maxDuration=60` if real production end-of-call
   processing approaches the ceiling; revisit `call_records` durability if
   Glass Box completeness becomes contractual; revisit the transcript
   resume strategy if Vapi retry payload ordering semantics change.
5. Production P0-004 conflict enforcement remains **OFF**; the P0-004
   manual production-enable gate remains outstanding.

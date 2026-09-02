# E01-02 — `forShop()` rollout across service-role paths (ADR-003 batches TS-1…TS-6)

_Cut 2026-09-01 by the Organizer for autorun Batch 2 (`../program/autorun.md`). Specification only._

## Ticket ID
E01-02

## Epic
E01 — Organization, tenancy and backend foundation (phase P1)

## Status
**draft — batch-gated.** Autorun Batch 2, queue item 6. Enters after E01-01 is committed on `auto/batch-2`. Risk class **tenancy** (service-role write paths; no schema). Founder acceptance **YES** (autorun table). Decisions binding: **ADR-003 accepted (founder-APPROVED 2026-09-01 at the P0-011 close — recorded in ADR-003 §Status; the autorun table's "D-0xx at closeout" placeholder resolves to that ADR approval, no separate D-number exists or is needed)**, D-012, D-024. TS-6 is closed-by-removal if CLEANUP-001 merged first (expected: Batch 1) — verify at start.

## Priority
P1 — High. ADR-003: ~130 hand-written `.eq("shop_id")` predicates and stamps across ~28 files remain "per-line discipline"; C-2 proved one missed line is a cross-tenant execution hole. With E01-01 adding members, service-role paths that resolve tenant by owner assumptions must be mechanized before more code accretes.

## Objective
Convert every remaining service-role call site to the `forShop` facade in the ADR-003 batch order (TS-1 crons + `automations.ts`; TS-2 session-context actions; TS-3 provider webhooks under their replay suites; TS-4 MCP + `agent-runtime`/`agent-events`; TS-5 design-gate re-evaluation recorded; TS-6 verify closed), shrinking the raw service-role surface to the explicit `unscoped` allowlist (`pricing_config`, `rate_limits`, metering writer, deliberate cross-tenant sweeps), locked by the inventory test.

## User outcome
Invisible to owners. Founder-as-operator: a future edit cannot silently drop a tenant predicate on a service-role path — the only way to write cross-tenant is to type `unscoped`, which review sees.

## Current code references
- Facade: `src/lib/supabase/for-shop.ts:38` (`select/update/delete/insert/upsert/unscoped`, `stamp()` `:32`, throws on empty id `:41-43`; header `:1-26` "design proof only"). Consumers today: `src/app/api/cron/roi-receipt/route.ts:22,96`; `src/app/api/cron/recovery-retention/route.ts:15,67,82`.
- Inventory lock: `eval/tenant-scoping.test.ts:66-98` `REVIEWED_IMPORTERS` (31 files), assertion `:100`.
- **TS-1 crons + automations:** `src/app/api/cron/agents/route.ts:12,33`; `cron/automations/route.ts:16,33`; `cron/no-show-ladder/route.ts:28,77,139`; `cron/reconcile/route.ts:15,37`; `cron/reminders/route.ts:26,59,130`; `cron/voice-sync/route.ts:16,50`; `cron/roi-receipt` `:23,64` (only the upsert is scoped); `cron/recovery-retention` (partial). `src/lib/automations.ts` injected client (`:177,223,261,276,369`), predicates `:194,232`, stamps `:239,294,405,448`.
- **TS-2 actions:** `src/app/actions/a2p.ts:9,68,110,120`; `twilio-provision.ts:17,91,132`; `quote-response.ts:9,34,102` (typed param `:79`); `voice-builder.ts:10,101,161,190`; `jobs.ts:26,499,541` (storage paths); `payments.ts:8,39`; `src/app/api/recovery/import/route.ts:19,106`; `recovery/import/[jobId]/extract/route.ts:20,54`; `src/app/api/admin/margin-report/route.ts:11,29`.
- **TS-3 webhooks (behavior-locked by suites):** `src/app/api/twilio/sms/route.ts:62,122`; `twilio/sms/status/route.ts:51,102`; `twilio/a2p/status/route.ts:19,55`; `src/app/api/vapi/webhook/route.ts:65,281`; `src/app/api/aurinko/webhook/route.ts:49,90` (deleted in E02-06 — convert anyway, cheap); `src/app/api/stripe/webhook/route.ts:36,137,357,558`. Suites: `eval/integration/twilio-inbound-replay.int.test.ts`, `twilio-status-callback.int.test.ts`, `vapi-replay.int.test.ts`, `eval/stripe-webhook-tenancy.test.ts`, `eval/webhooks.test.ts`.
- **TS-4:** `src/app/api/mcp/route.ts:16,73` (hands `createServiceClient()` + `shopId` `:70`; comment `:63-64` "every tool explicitly passes shop_id"); `src/lib/mcp/server.ts` predicates `:357,602,606,610,663,706,755,789`, stamps `:122,432,499,552`, ctx type `:52`; `src/lib/mcp/auth.ts:80-116`; `src/lib/agent-runtime.ts` (injected client; predicates `:133,174,202,321,400,432,458,574,605,623,761,777,789`; stamps `:237,456,649,826,984,1058,1219,1291`); `src/lib/agent-events.ts:22,86,95,106-109`.
- **TS-6:** `src/lib/slack.ts:249-265,321-336` bare-id writes — deleted by CLEANUP-001 (D-052); if not yet merged, convert.
- Legitimate `unscoped`: `src/lib/credits.ts:49` `meteringWriter()` (rationale `:41-47`); `src/lib/rate-limit.ts:20,82` (global table); `pricing_config` readers.
- ADR-003 §Migration cost: "3–5 ticket-sized batches, ~½ day each"; §Alternatives 1 (session-variable RLS) = TS-5 design gate at E01.

## Exact scope
1. **TS-1:** convert the 8 cron routes + `automations.ts` (injected client → accept a `ShopScopedClient` or construct `forShop` at the per-shop loop boundary); remove every hand-written predicate/stamp those files carried; deliberate cross-tenant sweeps (the per-shop loop's shop listing) use `unscoped` explicitly with a one-line justification comment.
2. **TS-2:** convert the session-context actions/routes listed; where the tenant comes from `requireShop()` the facade is constructed once at the top; storage-path code (`jobs.ts` photos) keeps the bucket key prefix pattern and adds the facade for row writes.
3. **TS-3:** convert the six provider webhooks **only with their replay suites green before and after** (P0-005/006/007/008 locks unchanged — never weakened); the tenant is still resolved exactly as today (from the trusted provider→shop lookup), then the facade is built from it; `provider_events` claims unchanged.
4. **TS-4:** `mcp/route.ts` constructs `forShop(service, auth.shopId)` and the server's `ctx` carries the scoped client (type change at `server.ts:52`); `agent-runtime.ts`/`agent-events.ts` accept a scoped client from callers (crons/actions already scoped by TS-1/TS-2); `agent-events` publisher-resolved shopId (P0-011 LOW) resolved by threading the id.
5. **TS-5 (design gate, recorded not built):** a one-page addendum to ADR-003 evaluating alternative 1 (session-variable RLS for service role) now that E01-01's `is_shop_member()` seam exists — recommendation + trigger conditions; **facade stays** unless the founder decides otherwise (decision-queue item only if the Builder recommends switching).
6. **TS-6:** verify `lib/slack.ts` is gone (CLEANUP-001); if not, convert the two writes.
7. **Inventory lock evolution:** `eval/tenant-scoping.test.ts` gains a second list — files allowed to import `createServiceClient` directly (the `unscoped`-only set: `credits.ts` metering writer, `rate-limit.ts`, `for-shop.ts`, `mcp/route.ts` and cron entry points that immediately wrap) — everything else must import the facade; a source-scan asserts no `.eq("shop_id"` predicate remains in converted files (they are redundant with the facade and would mask a missing one elsewhere).
8. Docs: ADR-003 status → "migration complete (TS-1…TS-4, TS-6); TS-5 addendum"; `08-security-and-reliability.md`; `program/backlog.md` P0-011 follow-ups closed.

## Explicit non-goals
- No schema/RLS changes (E01-01 owns policies). No session-variable implementation (TS-5 is a written evaluation).
- No behavior changes to webhooks, crons, or executors — pure mechanization; any needed behavior change is a HARD STOP (autorun rule 5 names `approvals.ts` executor semantics, webhook signature verification, `usage_events`/`credit_grants`/`payments` write paths — the metering writer stays `unscoped` and untouched).
- No new tables, no Slack/HCP code (deleted).

## Dependencies
- E01-01 committed (membership seam; TS-5 evaluation references it). CLEANUP-001 merged (TS-6 closure) — else convert.
- Decisions: ADR-003 accepted; D-012, D-024 — Approved.

## Expected modules affected
~28 files listed above; `eval/tenant-scoping.test.ts`; `eval/integration/tenant-isolation.int.test.ts` (extend with converted-path negatives); ADR-003 addendum; docs. Expect ±1 line per operation (ADR-003 property) — a ticket needing > 2× the listed files is a HARD STOP (autorun rule 5).

## Database impact
None.

## Migration impact
None (explicit).

## API impact
None. MCP tool contracts unchanged.

## UI impact
None.

## Permission impact
None.

## Tenant-isolation impact
Every converted path gains a cross-tenant negative in the integration suite (forged shop id in payload cannot re-tenant; empty shop id fails closed). Inventory lock enforces facade adoption.

## Security impact
Positive: closes the "safe-under-invariant" bare-id class (ADR-003 §Context) mechanically.

## Idempotency requirements
Unchanged — replay suites are the lock.

## Observability requirements
None new; `TENANT_SCOPE_VIOLATION` structured signal (P0-011) remains and now fires from the facade's empty-id refusal where applicable.

## Analytics requirements
None.

## Feature flag
None — invisible refactor gated by tests (E01 epic).

## Automated tests
- All existing replay/idempotency/tenancy suites green **unmodified** at each batch boundary (TS-1…TS-4 as separate commits inside the ticket is acceptable; the ticket still lands as one autorun commit — Builder may squash).
- New negatives per converted path (forged `shop_id`, empty id).
- Source-scan: facade import allowlist; no residual predicates in converted files; `unscoped` usages enumerated with justification comments (test asserts each `unscoped(` call site has a preceding `// unscoped:` comment).

## Manual acceptance procedure
1. Builder: run `npm test && npm run test:int` before and after each TS batch; paste totals (never lower).
2. Builder: local replay of one Twilio inbound, one Vapi end-of-call, one Stripe event with a forged cross-tenant id in the payload → refused/no-op exactly as P0-011 acceptance proved.
3. Builder: MCP tool call with a valid token → identical results; with a token of shop B → shop A rows unreachable.
4. **Founder:** on the batch preview: repeat step 2's Twilio + Vapi replays against the preview environment (founder-owned test numbers) and the MCP check; PASS/FAIL in `autorun-log.md`.

## Failure cases
- A conversion changes a query's semantics (e.g. a previously unscoped-by-mistake read now returns fewer rows) → the replay suite or a characterization test flags it; investigate: if the old behavior was the bug, fix and record; if intended cross-tenant, `unscoped` + comment.
- Type churn from `ShopScopedClient` in deep call chains → keep the facade at the boundary and pass the scoped builder down; never widen `forShop` with new verbs (ADR-003 shape).

## Rollback strategy
Revert the ticket commit; no data/schema involved.

## Definition of done
`../12-definition-of-done.md` plus: inventory lock updated (facade allowlist), per-batch test totals in the close record, ADR-003 status + TS-5 addendum merged, `program/backlog.md` P0-011 follow-ups closed, founder step 4 PASS recorded.

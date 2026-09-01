# P0-011 — Service-role tenant-scoping review and helper design

## Ticket ID
P0-011

## Epic
E00 — Stabilization

## Status
**done** (2026-09-01 — merged to `main` in PR #29, squash `e02c81a`; reviewed implementation = Builder `34c83fa` (2026-08-28) → Cursor review-fix accepted tree `3446fe2`; independent Cursor verdict **APPROVE AFTER LOCAL FIX** — two HIGH findings found and fixed pre-merge; founder acceptance **PASS** on the exact accepted SHA `3446fe2`; **ADR-003 founder-APPROVED** as the proposed direction. Full close record appended below. Prior state for history: ready-after-P0-002, promoted to next implementation position 2026-08-28 at the P0-010 close; the P0-009 mutual-exclusion precondition was satisfied 2026-08-26 and the post-P0-009 `approvals.ts` re-review item was completed in the sweep.)

## Priority
P0 — High. Audit doc 05 calls service-role discipline "the single largest structural risk in the data layer," and C-2 is the proof-of-pattern that a missed scope becomes a cross-tenant hole.

## Objective
(1) Sweep every service-role file for tenant-scoping discipline and fix the known gaps (C-2 shop binding, L-1, L-2, M-2); (2) design — not fully migrate — a `forShop(shopId)` scoped-query helper that converts scoping from per-line discipline into mechanism; (3) lock the current discipline with tenant-isolation tests.

## User outcome
No shop's data can be read or mutated through a machine path (webhook, cron, MCP, Slack, public page) that forgot a `.eq("shop_id")` — and future Builders get a mechanism that makes the mistake structurally harder.

## Current code references
- `createServiceClient()` (`src/lib/supabase/service.ts`) bypasses RLS; used in ~29–32 files: every webhook, every cron, MCP, Slack interactivity, recovery import, public quote page, several actions (audit docs 05 §RLS analysis, 06 §tenant-isolation model — the two docs count 29 and ~32; the sweep produces the authoritative list).
- **C-2:** `claimPendingAction` (`src/lib/approvals.ts:209`) updates by `.eq("id", pendingId)` with **no shop_id filter**; Slack route (`api/slack/interactivity/route.ts:64`) passes `pendingId` straight from the button payload — cross-tenant approval execution, dormant only because `FEATURES.slackApprovals=false` (audit doc 06 C-2; mitigation locked by D-026).
- **L-1:** `deleteService` (`actions/services.ts:209`) and `revokeMcpToken` (`actions/mcp.ts:60`) omit `.eq("shop_id")` on the RLS client (defense-in-depth inconsistency).
- **L-2:** `executeBookAppointment` `customers.update` missing shop_id (`approvals.ts:797`) — note: if P0-009 already fixed this line, verify and mark done, don't double-fix. (P0-009 done 2026-08-26 with tenant-scoped quote/lead/customer linkage enforced and acceptance-verified — verify this specific line at sweep, don't assume.)
- **Post-P0-009 re-review item (recorded at the 2026-08-26 P0-009 close, Cursor-noted pre-existing finding):** `recordPayloadReconciliation` in `approvals.ts` performs its update by id **without an explicit `shop_id` predicate**. Safe under the current claimed-UUID path, but the sweep must re-review `approvals.ts` as it stands after P0-009's executor changes and either add the predicate or document why the claimed-UUID invariant suffices.
- **M-2:** `saveCustomAgent`/`previewCustomAgentPlan` (`actions/custom-agents.ts:89,109`) accept `z.unknown()` cast to `AgentConfig` (audit doc 06 M-2; doc 09 names it the notable `any`-adjacent cast).
- Both RPCs (`match_customer_memory`, `match_shop_knowledge`) trust the caller's `p_shop_id` (audit doc 05).
- Helper concept: audit doc 09 §highest-cost decisions #2 — "a `forShop(shopId)`-scoped query helper (or Postgres-level session variable + RLS-for-service-role pattern) would convert discipline into mechanism."

## Exact scope
1. **The sweep:** enumerate every file importing the service client; for each query/mutation, verify explicit tenant scoping (or documented tenant-independence, e.g. `pricing_config`). Produce a checklist table (file · call sites · verdict · fix applied) in the completion report. Fix every miss found.
2. **C-2 fix:** thread an authorized `shopId` parameter into `claimPendingAction` (claim = `.eq("id").eq("shop_id").in("status", …)`); in-app callers pass the RLS-resolved shop; the Slack route resolves shop from the verified Slack team mapping — and remains behind `FEATURES.slackApprovals=false` per D-026 (this ticket does NOT re-enable Slack).
3. **L-1 / L-2:** add the missing `.eq("shop_id")` calls.
4. **M-2:** real zod schema for `AgentConfig` (audience filters whitelist, message template, channel, cadence — mirror the runtime's actual accepted shape) replacing the `z.unknown()` cast at both call sites.
5. **Helper design (ADR, no migration):** design `forShop(shopId)` — a wrapper over the service client that stamps/enforces `shop_id` on every table operation, with an explicit `unscoped()` escape hatch for the few legitimately global tables. Evaluate against the Postgres session-variable + RLS-for-service-role alternative. Deliverable: `docs/gradia-v2/adr/` entry with the chosen design, migration cost estimate, and the follow-up ticket list. Convert 1–2 low-risk call sites (e.g. one cron) as a proof, no more.
6. **Tenant-isolation tests:** add a test tier that exercises the fixed paths cross-tenant (two seeded shops; assert A's machine paths can't touch B): claim-by-wrong-shop fails; RPCs with mismatched `p_shop_id` return nothing harmful; the converted helper call sites enforce scope.

## Explicit non-goals
- **No full helper migration** across all ~30 files (that's the follow-up ticket set the ADR defines — migrating everything here would blow the scope and the WIP limits).
- No re-enabling Slack approvals (D-026).
- No RLS policy changes, no members/roles work (P1/E01).
- No changes to `pricing_config`/`rate_limits` deny-all posture.
- No ledger RLS tightening (`usage_events`/`payments`/`shop_metrics` FOR ALL → SELECT-only is **owned by P0-005 scope item 4** — corrected 2026-07-27; previously mis-pointed at a "separate migration ticket". D-024 territory).

## Dependencies
- Soft: P0-002 (so new tests gate CI).
- **Sequencing dependency (explicit, 2026-07-27):** C-2's fix touches `approvals.ts`, the same file as P0-009's executor changes — these two tickets must be **sequenced, never parallel** (whichever starts second rebases on the first; the WIP one-Builder-per-file discipline applies). Recorded as an edge in `../program/dependency-map.md`'s terms: P0-009 ⇄ P0-011 mutually exclusive in-flight.

## Expected modules affected
- `src/lib/approvals.ts` (claim signature)
- `src/app/api/slack/interactivity/route.ts`
- `src/app/actions/services.ts`, `actions/mcp.ts`, `actions/custom-agents.ts`
- Every service-role importer (audited; most unchanged, verdict recorded)
- New `src/lib/supabase/for-shop.ts` (or similar) — design proof only
- New ADR in `docs/gradia-v2/adr/`
- Tenant-isolation test files

## Database impact
None this ticket (helper design may propose session-variable RLS patterns — decision deferred to the ADR).

## Migration impact
None this ticket.

## API impact
- `claimPendingAction` signature change (internal API) — all callers updated in the same PR; no external contract change.

## UI impact
None. (Approvals UI behavior unchanged; claims still atomic.)

## Permission impact
- Slack path gains real shop binding (defense-in-depth for a disabled surface).
- No user-visible permission changes.

## Tenant-isolation impact
**This is the ticket.** Every fix converts an unscoped or discipline-only path to an explicitly bound one; the test suite makes regressions fail CI.

## Security impact
- Closes C-2 (the audit's #2 finding), L-1, L-2, M-2.
- Reduces the blast radius of every future missed-scope bug via the helper direction.

## Idempotency requirements
- `claimPendingAction` atomicity must be preserved exactly (status-guarded single-row update) — the added `.eq("shop_id")` must not change claim semantics. Locked by existing + new tests.

## Observability requirements
- Structured log on any claim attempt rejected for shop mismatch (this is an attack/bug signal, not noise — route it to `monitoring.ts` for P0-012 pickup).

## Analytics requirements
None.

## Feature flag
**None — fix + design.** The Slack surface's existing flag (`slackApprovals=false`) is the containment; nothing new to gate.

## Automated tests
- **Tenant-isolation:** cross-shop claim attempt fails and logs; L-1/L-2 paths cross-checked with two seeded shops; RPC `p_shop_id` mismatch cases.
- **Unit:** new AgentConfig zod schema accepts every currently-valid saved config shape (fixture from real recipe + freeform plans) and rejects malformed filter keys; claim signature callers compile + behave.
- **Integration:** approval claim/execute round-trip with shop binding on real Postgres (integration tier).
- **Failure-path:** claim with valid pendingId + wrong shop → pending action untouched, still claimable by the right shop.
- **Regression lock:** source-scan test asserting `claimPendingAction` call sites always pass a shopId (pattern: the same source-scan technique the eval suite already uses for send-tool absence).

## Manual acceptance procedure
1. Two seeded shops A and B. As A's owner, approve one of A's actions in-app → executes normally.
2. Craft a claim for B's pending action id through A's context (direct call in a test harness) → refused, B's action still pending, structured log emitted.
3. Save a custom agent with a hand-broken config payload (bad filter key) → zod rejection with actionable message; existing saved agents still load and run.
4. Delete a service / revoke an MCP token as the owning shop → works; verify the queries now carry shop_id (code review + test, not runtime).
5. Review the ADR: design, alternatives considered, migration estimate, follow-up tickets enumerated; 1–2 converted call sites pass their tests.
6. Completion report contains the full sweep table covering every service-role file.

## Failure cases
- A legitimate global (non-tenant) service-role query flagged by the sweep → document as tenant-independent with justification, don't force a bogus scope.
- Existing saved `custom_agents.config` rows that fail the new schema → migration decision: tolerate-and-log on read (never brick saved agents), flag count in completion report.
- Claim signature change misses a caller → compile error (TypeScript strict) — the safety net; verify with grep anyway.

## Rollback strategy
Revert the PR (code + tests only, no migrations). The ADR remains as a document regardless. No data changes to unwind.

## Definition of done
Per `12-definition-of-done.md`, plus: sweep table complete over the authoritative file list (count reconciled against the audit's 29 vs ~32 discrepancy), C-2/L-1/L-2/M-2 each individually evidenced, ADR reviewed by the Organizer and queued for founder sign-off, and tenant-isolation tests green in gating CI.

---

## Close record (2026-09-01)

**Merged:** PR #29 "fix: harden service-role tenant scoping", merged to `main` 2026-09-01 as squash **`e02c81a`**. Reviewed implementation history: Builder **`34c83fa`** (2026-08-28, 31 files +1,507/−169) → independent Cursor review-fix, accepted tree **`3446fe2`** (2026-09-01). CI on the exact accepted SHA: `ci / checks` PASS · `ci-integration / integration` PASS · Vercel + Vercel Preview Comments PASS. **No migration** (as specced).

**Cursor review: APPROVE AFTER LOCAL FIX — two HIGH findings, both fixed pre-merge in `3446fe2`:**
- **HIGH #1 — forShop update re-tenanting:** `forShop.update()` scoped the WHERE to the authorized shop but did not stamp `shop_id` into SET — a forged update payload could attempt to MOVE a row into another tenant. Fixed: `update` now stamps the trusted shop_id like insert/upsert (forged payload `shop_id` always loses); locked by new facade unit tests + a real-Postgres re-tenant-attack test.
- **HIGH #2 — Connect events on the platform billing path:** a Stripe **Connect** `checkout.session.completed` (attacker-mintable on a connected account, carrying arbitrary `client_reference_id` / `metadata.shop_id`) could enter the PLATFORM subscription handler and write another shop's `shops.plan` / `stripe_subscription_id` / `credit_grants`. Fixed: events carrying an `account` envelope are rejected from the platform billing handler before any tenant mutation; locked by new `eval/stripe-webhook-tenancy.test.ts` (214 lines).

**Founder acceptance: PASS** on `3446fe2` (npm test 660 passed / 4 skipped · tsc clean · lint clean · build clean · integration 109/109 on real Postgres). Verified: Shop A approval executed exactly once; A claiming B's pending action refused with B untouched, `TENANT_SCOPE_VIOLATION` structured log emitted, and B still able to execute legitimately afterward; the forShop re-tenant attack failed (A-owned row stayed A's despite a B `shop_id` in the update payload) while legitimate updates worked; forged Connect metadata caused **no** `shops.plan` change, **no** `stripe_subscription_id` mutation, **no** `credit_grants` write, with legitimate platform checkout behavior intact; invalid and forged-`shop_id` agent configs rejected by the strict schema with existing valid configs compatible; owning-shop service delete / MCP revoke worked while foreign identifiers could not mutate another tenant; Slack approvals remain disabled with the interactivity route structurally dormant, and callback binding requiring pending id + `slack_channel` + `slack_message_ts`; approvals claim/rollback/execution, `recordPayloadReconciliation` (read AND write), changed cron paths, the public-quote token→quote→shop chain, and MCP token→shop resolution all confirmed tenant-bound; the service-role importer inventory stands at exactly **31**; P0-005 financial SELECT-only owner RLS intact; billing model unchanged; **P0-005/006/007/008/009/010 regressions all PASS**; production conflict enforcement OFF; P0-012 and P0-013 not started.

**Test-infrastructure note (not a P0-011 regression):** the first local acceptance integration run hit a P0-009 `quote_response` rate-limit **fixed-window timing flake**; the test passed in isolation, passed on full-suite rerun, and CI integration was green on the exact accepted SHA. Recorded as a known flaky-test follow-up in `../program/backlog.md` test-infra hygiene.

**ADR-003 — FOUNDER-APPROVED** as the proposed direction (`forShop(client, trustedShopId)`: explicit trusted shopId; scoped select/update/delete; insert/upsert/UPDATE all stamp the authorized shop_id so forged payload shop_id loses; empty shopId fails closed; explicit loud `unscoped` escape hatch). The full repository migration is NOT started — TS-1…TS-6 remain future follow-up work for the Organizer to sequence post-P0.

### Sweep table (scope item 1 — reconciled at close; residual M4 satisfied)

Authoritative inventory: **31 files** import `createServiceClient` (resolving the audit's "29 vs ~32"), locked in code by the `REVIEWED_IMPORTERS` allowlist test (`eval/tenant-scoping.test.ts`) — a new importer fails CI until deliberately reviewed and added. Verdicts are POST-fix (`3446fe2`). "S-U-I" = safe-under-invariant: every id in the operation came from an already-tenant-scoped read/insert in the same flow; the invariant is named and rides the ADR-003 migration batches.

| File | Tenant identity source | Verdict | P0-011 action |
|---|---|---|---|
| `actions/a2p.ts` | session `requireShop()` | SAFE | none |
| `actions/jobs.ts` | session; service client for storage only, paths prefixed `${shop.id}/` | SAFE | none |
| `actions/payments.ts` | session | SAFE | none |
| `actions/quote-response.ts` | opaque public token → quote row (`quote.shop_id`) | SAFE (was S-U-I) | `viewed_at` stamp now carries `.eq("shop_id")` |
| `actions/twilio-provision.ts` | session | SAFE | none |
| `actions/voice-builder.ts` | session | SAFE | none |
| `api/admin/margin-report` | `CRON_SECRET`; deliberately cross-tenant, read-only | SAFE (by design) | none |
| `api/aurinko/webhook` | HMAC → `aurinko_account_id` mapping | SAFE | none |
| `api/cron/agents` | `CRON_SECRET` → server-loaded agents | SAFE | none |
| `api/cron/automations` | `CRON_SECRET` → shop iteration | SAFE | none |
| `api/cron/no-show-ladder` | `CRON_SECRET`; `shops!inner` joined rows | SAFE (was S-U-I) | appointment stamp now shop-scoped |
| `api/cron/reconcile` | `CRON_SECRET`; read-only by design | SAFE | none |
| `api/cron/recovery-retention` | `CRON_SECRET`; own scoped scan | SAFE (was S-U-I) | **converted to `forShop`** (ADR-003 proof) |
| `api/cron/reminders` | `CRON_SECRET`; joined rows | SAFE (was S-U-I) | appointment stamp now shop-scoped |
| `api/cron/roi-receipt` | `CRON_SECRET`; active-shop iteration | SAFE | **converted to `forShop`** (ADR-003 proof) |
| `api/cron/voice-sync` | `CRON_SECRET` | SAFE | none |
| `api/mcp/route` (+`lib/mcp/server`) | bearer token → `mcp_tokens.shop_id`, `ctx.shopId` threaded | SAFE | none |
| `api/recovery/import/[jobId]/extract` | session + `jobId` independently re-verified shop-scoped at every entry | S-U-I (documented) | none (TS-2) |
| `api/recovery/import` | session | SAFE | none |
| `api/slack/interactivity` | **was the C-2 hole** — button payload id only, service role, no shop binding (dormant behind the flag) | **FIXED** | route 404s while `slackApprovals` off; when on, tenant = the posted card's stored `slack_channel`+`slack_message_ts` matched against the callback container; bound row's shop drives the claim |
| `api/stripe/webhook` | signature; account→shop / checkout metadata / subscription-id mapping | **FIXED** (was SUSPICIOUS) | mandatory tenant resolution before tenant-row work (unmapped Connect account acks+logs, never unscoped queries); refund path fully scoped; **HIGH #2**: Connect events rejected from the platform billing handler |
| `api/twilio/a2p/status` | `?shop=` as lookup hint + per-shop subaccount signature as the gate | SAFE | none |
| `api/twilio/sms` | P0-006 pattern (signature → number mapping) | SAFE (spot-checked) | none |
| `api/twilio/sms/status` | P0-008 pattern | SAFE (spot-checked) | none |
| `api/vapi/webhook` | P0-007 pattern (signature → assistant mapping, prod fallback fails closed) | SAFE (spot-checked) | none |
| `lib/agent-events.ts` | publisher-resolved `event.shopId` (all current publishers server-resolve) | SAFE (inherited — LOW recorded) | none (TS-4) |
| `lib/credits.ts` | explicit `shopId` param from callers | SAFE | none |
| `lib/mcp/auth.ts` | the presented credential's own row (hash lookup) | S-U-I (self-row usage counter — LOW) | none (TS-4) |
| `lib/rate-limit.ts` | explicit `(shop_id, bucket, window)` keys | SAFE | none |
| `lib/slack.ts` | caller-fed `pendingActionId`, no shop context in-module | S-U-I | deferred — **residual M2 / TS-6** |
| `lib/supabase/service.ts` | (the factory itself) | n/a | none |

Supplementary (receive a service client without importing the factory): `lib/approvals.ts` — was the C-2 core, now tenant-bound end to end (claim `.eq("shop_id")`, all post-claim writes + rollback scoped to `claimed.shop_id`, `recordPayloadReconciliation` read+write scoped — the post-P0-009 re-review item, closed); `lib/automations.ts` — scoped inserts, `automation_runs` claim transitions S-U-I (own-insert ids, TS-1); `lib/agent-runtime.ts` — all reads/inserts scoped; auto-execute select now also carries `.eq("shop_id")`.

### Scope items — individually evidenced
1. **Sweep:** table above; inventory locked in CI. 2. **C-2:** `executeApproval`/`executeRejection`/`markEditRequested` take an authorized `shopId`; claim is atomic on `.eq("id").eq("shop_id").in("status")`; zero-row claims probe and emit `TENANT_SCOPE_VIOLATION` via `lib/monitoring.ts` (P0-012 pickup); Slack route bound as above and **not re-enabled** (D-026). 3. **L-1:** `deleteService` + `revokeMcpToken` carry explicit `.eq("shop_id")`; **L-2:** verified already fixed by P0-009 (customers updates shop-scoped) — no double-fix. 4. **M-2:** `lib/agent-config-schema.ts` strict runtime-shape zod at `saveCustomAgent`/`previewCustomAgentPlan` (planner's eval-locked tool schema untouched; reads of saved rows stay tolerant). 5. **Helper design:** ADR-003 (founder-approved) + `lib/supabase/for-shop.ts` + two cron proof conversions. 6. **Tests:** `eval/integration/tenant-isolation.int.test.ts` (incl. the re-tenant attack), `eval/slack-interactivity.test.ts`, `eval/agent-config-schema.test.ts`, `eval/tenant-scoping.test.ts` (claim-arg scan + importer inventory), `eval/stripe-webhook-tenancy.test.ts` (review-fix); existing claim-signature suites extended, never weakened.

### Residual findings (preserved, not fixed)
- **M1 — Slack tenant binding uses channel+message_ts, not a team/workspace→shop identity.** Sufficient for the disabled surface; a real workspace→shop mapping is REQUIRED before any Slack re-enable (rides D-026's re-enable gate).
- **M2 — `storeSlackRef`/`updateSlackForPending` remain bare-id writes** (module has no shop context by design; callers verified correct today). Track with TS-6 / the Slack tenant-binding follow-up.
- **M3 — `executeCancelAppointment` deletes the appointment by id after a shop-scoped load** — pre-existing invariant, documented (mechanized by the ADR-003 migration when approvals.ts converts).
- **M4 — Builder sweep-table documentation gap** — satisfied by this close record.
- **LOW/OPTIONAL (accepted):** whitespace-only shopId passes `forShop`'s empty-check; cross-tenant claims surface as `already_decided` rather than a distinct mismatch status (information-poor by choice; the structured log carries the signal); `match_customer_memory` mismatch lacks the integration test its `match_shop_knowledge` twin has; MCP usage counter stays id-only after the trusted credential lookup; quote-response race-echo SELECT stays id-only; some vehicle patches use bare id after trusted resolution; `agent-events` relies on publisher-resolved shopId until TS-4; the Slack route tests flip the frozen FEATURES object via cast.

**Standing state at close:** Slack approvals OFF (D-026) · production conflict enforcement OFF · billing model unchanged and Production checkout fail-closed pending P0-013 · P0-012 not started · P0-013 not started · no migration shipped.

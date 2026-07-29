# P0-011 — Service-role tenant-scoping review and helper design

## Ticket ID
P0-011

## Epic
E00 — Stabilization

## Status
**ready-after-P0-002** (reconciled with the index 2026-07-28) — no hard dependencies or open decisions; enters review only after P0-002 per the global review gate, so the new tenant-isolation tests gate from day one. Sequencing note: mutually exclusive in-flight with P0-009 (both touch `approvals.ts` — see Dependencies). The helper **design** portion produces an ADR, which needs Organizer/founder sign-off before any migration ticket is cut.

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
- **L-2:** `executeBookAppointment` `customers.update` missing shop_id (`approvals.ts:797`) — note: if P0-009 already fixed this line, verify and mark done, don't double-fix.
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

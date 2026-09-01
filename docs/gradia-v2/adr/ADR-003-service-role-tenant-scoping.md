# ADR-003 — Service-Role Tenant-Scoping Mechanism (`forShop`)

**Status:** proposed (P0-011 Builder, 2026-08-28 — needs Organizer review and founder sign-off before the migration ticket set is cut; the design-proof conversions and the facade itself ship with P0-011 and stand regardless).

## Context

`createServiceClient()` bypasses RLS. The P0-011 sweep (completion report,
2026-08-28) classified all 31 importers: every entry point resolves its tenant
from a trusted server-side source, but on tenant-owned tables the scoping
itself is **per-line discipline** — ~130 hand-written `.eq("shop_id", …)`
predicates and `shop_id:` insert stamps across ~30 files, plus a set of
"safe-under-invariant" bare-id mutations whose safety rests on a nearby
scoped read that a future edit could silently separate from its write. Audit
doc 05 calls this "the single largest structural risk in the data layer";
C-2 (`claimPendingAction` claiming by bare id from the Slack callback) was
the proof that one missed line becomes a cross-tenant execution hole.

P0-011 fixed the concrete gaps (C-2, L-1, L-2-verified, M-2, the Stripe
webhook's conditional scoping, and the bare-id stamps in the reminder/no-show
crons) and added the tenant-isolation test tier. This ADR decides the
*mechanism* that keeps the next 30 files from re-growing the problem.

## Decision

**A thin, explicit facade: `forShop(client, shopId)`**
(`src/lib/supabase/for-shop.ts`), shipped as a design proof in P0-011 with
two cron call sites converted (`cron/roi-receipt` upsert-stamping,
`cron/recovery-retention` update-scoping).

Shape (deliberately small — five verbs and an escape hatch):

- `select / update / delete` return the live PostgREST builder with
  `.eq("shop_id", shopId)` pre-applied; call sites keep chaining exactly as
  with the raw client.
- `insert / upsert` stamp `shop_id` onto every row — the authorized tenant
  always overrides anything the payload carried (forged `shop_id` in content
  can never choose tenancy). `update` stamps the same way, so a forged
  `shop_id` in the patch cannot MOVE a row into another tenant (WHERE
  remains the authorized shop; SET cannot change tenancy).
- `unscoped` exposes the raw client for the legitimately global tables
  (`pricing_config`, `rate_limits`) and deliberate cross-tenant sweeps —
  making the exception *loud and greppable* instead of an absent predicate.
- Construction throws on an empty `shopId` (fail closed at the source).

Properties: no ORM, no repository layer, no global mutable state, no type
gymnastics (return types are inferred from supabase-js); a converted call
site diffs to ±1 line per operation.

## Alternatives considered

1. **Postgres session variable + RLS-for-service-role** — run service-role
   connections with `SET LOCAL app.shop_id = …` and add RLS policies
   (`USING (shop_id = current_setting('app.shop_id')::uuid)`) that also bind
   the service role. Strongest guarantee (database-enforced, covers raw SQL
   and future RPCs automatically) — but: supabase-js uses PostgREST over
   pooled connections, so per-request `SET LOCAL` requires wrapping every
   operation in an RPC or adopting a direct-Postgres client; every RPC
   (`write_appointment_serialized`, `claim_provider_event`, matchers) needs
   re-plumbing; and the deny-by-default flip is a big-bang migration with
   RLS-policy blast radius P0 explicitly excludes ("no RLS policy changes").
   **Rejected for now; remains the candidate end-state if E01 adopts a
   direct DB layer.** The facade is forward-compatible: call sites that took
   an explicit `shopId` are exactly the ones a session-variable layer needs.
2. **Discipline + linting only** (source-scan tests for `.eq("shop_id")`
   near every `.from(`) — cheap but dishonest: scanners can't see provenance
   (is the id trusted?), produce false confidence, and the audit already
   showed discipline decays. Kept only as the *inventory* lock
   (`eval/tenant-scoping.test.ts` reviewed-importers list), not as the
   scoping mechanism.
3. **Full repository/ORM layer** — hides tenant identity inside an
   abstraction, violates the "no framework migration" principle, and costs
   far more than the risk it retires. Rejected.

## Consequences

- Migrating a file removes its per-line predicates and makes an unscoped
  operation impossible to write *silently* — `unscoped` is the only door and
  it names itself in review.
- The facade is untyped per-table (accepts any table string). Acceptable at
  this scale; the session-variable end-state (alternative 1) is the answer
  if stronger guarantees are wanted, not a typed table map.
- Two mechanisms coexist during migration (raw + facade). The inventory test
  keeps every service-role file visible; each conversion shrinks the raw
  surface.

## Migration cost estimate

~28 remaining importer files. Mechanical per file (predicate/stamp → facade),
riskiest are the webhooks (behavior-locked by the P0-005/006/007/008 suites —
convert only with those suites green). Estimate: 3–5 ticket-sized batches,
~½ day each including test updates. No migrations, no schema changes.

## Follow-up ticket list (for the Organizer to sequence — post-P0)

1. **TS-1:** convert the remaining crons (`agents`, `automations`,
   `no-show-ladder`, `reminders`, `reconcile`, `voice-sync`) + `lib/automations.ts`.
2. **TS-2:** convert the session-context actions that use the service client
   (`a2p`, `jobs` storage paths, `payments`, `twilio-provision`,
   `voice-builder`, recovery import routes).
3. **TS-3:** convert the provider webhooks (Twilio ×3, Vapi, Aurinko,
   Stripe) under their replay suites.
4. **TS-4:** convert MCP (`lib/mcp/server.ts` threading `ctx.shopId`) +
   `agent-runtime.ts` / `agent-events.ts`.
5. **TS-5 (design gate):** re-evaluate alternative 1 (session-variable RLS)
   at E01 when members/roles land — decide facade-forever vs DB-enforced.
6. **TS-6 (small):** thread a `shopId` into `lib/slack.ts`
   `storeSlackRef`/`updateSlackForPending` (last invariant-dependent bare-id
   writes on `pending_actions`).

## Links

- Ticket: `../tickets/P0-011-service-role-tenant-scoping-review.md`
- Sweep + fix evidence: P0-011 completion report (ticket file close record)
- Audit: doc 05 §RLS analysis, doc 06 C-2/L-1/L-2/M-2, doc 09 §highest-cost
  decisions #2
- Tests: `eval/tenant-scoping.test.ts`,
  `eval/integration/tenant-isolation.int.test.ts`
- Proof conversions: `src/app/api/cron/roi-receipt/route.ts`,
  `src/app/api/cron/recovery-retention/route.ts`

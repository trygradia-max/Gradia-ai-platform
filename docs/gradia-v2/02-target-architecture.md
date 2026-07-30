# 02 — Target Architecture

_Created 2026-07-25 by the Organizer. Precedence layer 4. Describes where the architecture goes and — just as important — where it deliberately does not. Current reality: `01-current-state.md` / audit doc 02. Mechanism-level choices get ADRs in `adr/` as they are made._

## Shape: the modular monolith stays

One Next.js app, one Postgres, one deployable (D-007). The audit (doc 02) confirms the discipline is real: domain logic in `src/lib/`, UI reads through `src/lib/data/*` accessors, thin server actions (auth → zod → lib), provider seams honored. **Do not migrate to microservices without measured need** (D-008) — "measured" means a documented scaling or reliability metric the monolith demonstrably cannot meet, recorded as an ADR.

Target evolution is *within* the monolith:

```
Browser ── Next.js App Router (Vercel)
  ├─ proxy.ts: session + org/member resolution (E01) + flag gates
  ├─ Server Components → data accessors → RLS session client
  ├─ Server Actions: auth → zod → domain fn
  └─ API: owner routes (SSE) · webhooks (sig-verified → idempotency keys → domain fns)
       · crons (→ outbox/queue workers at P10)
Domain layer (src/lib): CRM · scheduling/availability (E02) · jobs (E04)
  · invoicing/payments (E05) · recurring/memberships/fleets (E06, three modules)
  · comms · imports · approval engine · agent planner/runtime · shared brain
Seams: voice-provider · telephony-provider · crm-provider · llm (NEW) · calendar-sync (NEW)
Supabase: Postgres (RLS via membership) + pgvector + Storage · Stripe (billing + Connect)
```

## Invariants preserved (decided — do not "improve" away)

1. **Planner → deterministic runtime** (D-009). The LLM plans once (closed recipe catalog or whitelisted freeform); deterministic code executes. Single-turn workers stay single-turn. No unified runtime brain — unification only at the context layer (memory, identity, KB, `persona.ts`).
2. **The universal approval engine** (D-011). `pending_actions` + the ONE executor (`approvals.ts`) remains the sole path for AI-initiated side effects. New action types extend the enum and executor; nothing routes around it. Payloads get zod schemas per action type (audit 11 §AI layer).
3. **Business and compliance rules in code, test-locked** (D-012). ALWAYS_HITL floor (money + calendar + high-ticket per D-021), send policy, TCPA/FTC gates, entitlements. New rules land as code + locking test, never as prompt text.
4. **One send path, one pricing module, one persona.** The single-path invariants the audit calls the most valuable structural property (doc 09) are protected: any second path is an architecture regression.
5. **Provider seams** (locked principle #8). Vendor types never leak past `voice-provider.ts` / `telephony-provider.ts` / `crm-provider.ts` — and the two seams to **add**: the AI gateway (`ModelProvider`) and a calendar-sync seam (below).

### Provider boundaries (D-029 / ADR-002 — approved 2026-07-27)

**Gradia domains depend on Gradia-owned interfaces, not vendor-specific behavior.**

| Domain | Gradia-owned interface | Providers behind it |
|---|---|---|
| Calendar | `CalendarProvider` | Aurinko / Google Calendar / Microsoft Graph |
| AI gateway | `ModelProvider` | Anthropic / OpenAI |
| Voice | `VoiceProvider` | Vapi / future provider |
| Telephony | `TelephonyProvider` | Twilio / future provider |
| Payments | `PaymentsProvider` | Stripe / future provider |
| Customer integration | `CRMConnector` | Jobber / Housecall Pro / future provider |

The AI gateway (`ModelProvider`) is the E01 LLM-seam deliverable; Aurinko is a **transitional** provider behind `CalendarProvider` (D-030); provider-specific IDs, cursors, payloads and sync state stay inside integration records and provider adapters, and core business entities use Gradia-owned identifiers. Vendor classifications and per-provider facts: `vendors/registry.md`.

## Target changes (the deltas)

### Tenancy becomes mechanism, not discipline (E01 / P1 — D-018)
- `organizations` (today's `shops`) gain `members` (user_id, org_id, role) + invitations; RLS policies move from `owner_id = auth.uid()` to membership indirection; `requireShop` → `requireMember(role)`.
- **Service-role scoping gets a mechanism:** a `forShop(shopId)`-scoped query helper (or Postgres session-variable + RLS-for-service-role pattern) so a missed `.eq("shop_id")` is impossible rather than merely rare (audit 05 §RLS names this the single largest structural data-layer risk; design in P0-011, build in E01).
- Sequenced **before** major schema expansion (D-018): E04/E05/E06 tables are born multi-user.

### Scheduling: Gradia owns the calendar (E02 / P2 — D-013/D-014/D-015/D-016)
- Reverses today's audited model where booking hard-requires Aurinko and Google is authoritative (`approvals.ts:686`, audit 04-D). `appointments` + a new availability engine (working hours, resources, blocks, travel) become the source of truth; **Google and Microsoft calendars are synchronized mirrors** behind a calendar-sync seam — subordinate, reconnectable, optional.
- Conflict policy: automatic paths hard-block (D-015); human-approved paths warn with a documented override (D-016). P0-003/004 deliver conflict enforcement on the *current* model first; E02 replaces the dependency.

### The AI gateway (`ModelProvider`) — the LLM seam (P1, design direction from audit 07/09; D-029)
- One `llm.ts`: model registry per task tier, timeouts, retries with error taxonomy, no hardcoded model ids outside it (~14 modules today, grep-verified 2026-07-27), `GRADIA_LLM_MODEL` stripped of production effect. Embedding model/dimension become migratable (re-embed pipeline is P10 scope).
- **Task aliases (amended 2026-07-27, per the founder master definition):** the registry exposes named aliases, not raw model IDs — `fast` (Haiku-class workers), `standard` (drafting/BI), `reasoning` (planner/verifier). Callers request an alias; the gateway resolves provider + model.
- **Fallback chains:** each alias carries an ordered fallback (e.g. Anthropic → OpenAI equivalent) with the same timeout/retry taxonomy; a fallback invocation is recorded as such (cost/latency/failure rows tag the provider actually used). Today there is no fallback chain — a live gap the E01 seam closes.
- **Prompt & model versioning:** every gateway call records prompt version + resolved model version so eval results (locked principle #6) bind to exact (prompt, model) pairs; a model/prompt change without a passing eval run is blocked by CI, not convention.
- **Scope exclusions (explicit, not silent):** `embedding`, `voice`, and `transcription` aliases are **out of E01 gateway scope** — embeddings because the vendor + dimension are baked into the schema (`vector(1536)`; migratable only via the P10 re-embed pipeline), voice because the realtime LLM is hosted inside Vapi's pipeline (`vapi.ts` model config — governed by `VoiceProvider`, not `ModelProvider`), transcription likewise (Whisper STT rides the voice/Whisper paths). Each becomes a gateway alias only when its P10/E02+ prerequisite lands; until then these three remain provider-pinned and are tracked in `vendors/registry.md`.

### Payments: Stripe Connect first (E05 / P5 — D-019)
- Customer-facing money (quote deposits, job invoices) builds on the existing flagged-off Connect foundation. Financial records immutable and replay-safe (D-024): append-only ledgers, provider-ref idempotency keys, owner sessions read-only on money tables (fixes audit 05 §4).

### Reliability spine (P0 now, P10 completion)
- **Now (P0):** provider-event idempotency via DB unique keys (D-023); alert delivery for monitoring/reconciliation/cron failures; error boundaries.
- **P10:** `domain_events` outbox + retrying worker + dead-letter, replacing check-then-insert idempotency and giving crons catch-up; structured logging, `/api/health`, tracing sample; soft delete + data export/deletion (de-fang the `auth.users → shops → everything` cascade, audit 05 §2).

### Experience platform (E08 / P8 — D-020)
- **Responsive PWA precedes native mobile.** Installable, offline-tolerant reads, mobile-first flows per `ui/responsive-rules.md`. No React Native/Swift before the PWA is complete.

## Refactor directions (directions, not tickets — from audit 09)

- **`shops` god-table split**: credentials → `shop_connections` (column privacy, per-integration rows); plan/billing state separated. Do it as E01 touches the table anyway.
- **God-file splits** when next touched: `agent-runtime.ts` (2,293 lines), `approvals.ts` (1,422), `mcp/server.ts`, `stripe/webhook/route.ts`. Split by concern; never fork the single executor path.
- **Single-truth pass** (E03): retire `leads.status`, flat vehicle columns, triplicate activity timestamps; generated DB types (`supabase gen types`) end hand-written drift.
- **Silent-failure culture → observable failure**: keep availability-first behavior, add alert delivery so degradation pages someone (P0-012).

## Explicit non-migrations (rejected — an ADR is required to reopen any of these)

| Rejected | Authority | Note |
|---|---|---|
| Microservices / service split | D-008 | Without measured need, ever. |
| LangGraph or any agent framework | D-010 | `@langchain/anthropic` stays a structured-output convenience only; hand-rolled SDK calls are deliberate. |
| Unified runtime brain | D-009 / locked #3 | Context-layer unification only. |
| Fine-tuning; auto-published model-authored skills | Locked #5 | — |
| Text-to-SQL BI | Audit 06 §Injection + roadmap §rejects | Fixed, parameterized query builders stay. |
| Slack approvals revival | D-026 | Requires rebuilt tenant authorization + ADR first (C-2). |
| ORM adoption mid-stream | Status quo + audit 05 | Generated types yes; a Drizzle/Prisma migration is not scheduled and needs an ADR. |
| Native mobile before PWA | D-020 | — |

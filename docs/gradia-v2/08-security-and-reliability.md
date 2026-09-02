# 08 — Security & Reliability

_Created 2026-07-25 by the Organizer. Grounded in the 2026-07-20 audit (`platform/docs/audit/06-security-and-tenancy-audit.md`, `05-database-audit.md`, `10-production-readiness.md`). Governs security and reliability requirements for all epics/tickets; the audit remains the layer-1 record of what is true today._

## 1. Security posture today (audited)

Audit scores: security **4/10** (capped by C-1), reliability **5/10**, observability **4/10**. Architecture alone would score ~7 — the deductions are operational.

### Findings → remediation map

| Finding | Severity | Summary | Remediation |
|---|---|---|---|
| C-1 | **CRITICAL** | Live Supabase Postgres superuser connection string (with password) committed at `.gitignore:46`, in pushed git history. Bypasses RLS and the app entirely. | **P0-001** (rotate today; scrub decision = decision queue) |
| C-2 | CRITICAL (dormant) | `claimPendingAction` has no shop binding under service-role; Slack interactivity path can execute any shop's approval. Mitigated only by `FEATURES.slackApprovals=false`. | **Closed 2026-09-01 by P0-011** (PR #29 `e02c81a`): claims are tenant-bound (`executeApproval`/`executeRejection`/`markEditRequested` take an authorized shopId; atomic `.eq("shop_id")` predicate; cross-tenant attempts refuse with zero writes + `TENANT_SCOPE_VIOLATION` structured log); the Slack route is now structurally dormant behind the flag AND, when enabled, binds tenant from the posted card's stored `slack_channel`+`slack_message_ts`. D-026 still locks the flag off; residual M1 (a real workspace→shop identity) is REQUIRED before any re-enable — recorded in the P0-011 close record + `program/backlog.md`. |
| H-1 | HIGH | `.env.local` plus four backup variants on disk — multi-copy leak hazard. | **P0-001** (consolidate/delete alongside rotation) |
| M-1 | MEDIUM | `processRawLeadNote` (`actions/ai-lead.ts:24`) unauthenticated, unmetered LLM call — cost/DoS amplifier. | **Closed 2026-08-28 by P0-010** (PR #27): session auth + server-derived shop + fail-closed plan/credit gates + `ai_lead` 20/60s rate bucket + credits=0 cost-visibility metering; founder acceptance verified the unauthenticated replay refused with zero writes |
| M-2 | MEDIUM | Agent `config` accepted as `z.unknown()` cast to `AgentConfig`, feeds audience queries/prompts. | **Closed 2026-09-01 by P0-011** (PR #29): `lib/agent-config-schema.ts` — strict runtime-shape zod (whitelisted freeform filter keys, bounded recipe params, unknown/forged keys rejected) enforced at `saveCustomAgent` + `previewCustomAgentPlan`; the planner's eval-locked tool schema untouched; reads of saved rows stay tolerant |
| L-1/L-2 | LOW | Missing `.eq("shop_id")` on two RLS-client mutations; one executor update unbound. | **Closed 2026-09-01 by P0-011** (PR #29): L-1 — `deleteService` + `revokeMcpToken` carry explicit `.eq("shop_id")` (defense-in-depth alongside RLS, acceptance-verified both directions); L-2 — verified already fixed by P0-009 (executor `customers` updates shop-scoped), no double-fix |
| L-3 | LOW | Public quote token: uuid-derived (not CSPRNG-guaranteed), no expiry, no rate limit on `/q/[token]`. | **P0-009 — partially closed 2026-08-26** (PR #25: `valid_until` enforced server-side; `respondToQuote` rate-limited via `rate-limit.ts`, shop-keyed, + token length-check parity). Remaining: `randomBytes` token regeneration + token-level expiry — deferred E03-era follow-up (backlog) |

**Strengths to preserve (never regress):** uniform RLS on all 28 tables; all four provider webhooks signature-verified, timing-safe, fail-closed, test-locked; no text-to-SQL; no direct LLM-triggered side effects; money+calendar ALWAYS_HITL in code; AES-256-GCM for stored credentials; CSRF-protected OAuth.

## 2. Tenancy

**Today:** single-owner shops. RLS is the primary defense for session traffic (~69 modules on the anon/session client). **Service-role paths (exactly 31 files as of the 2026-09-01 P0-011 close: every webhook, cron, MCP, Slack, public quote) bypass RLS and rely on `.eq("shop_id")` code scoping** — but that scoping is now partially mechanism, not purely discipline: the P0-011 sweep classified all 31 (table in the ticket close record), the inventory is CI-locked (`eval/tenant-scoping.test.ts` — a new importer fails CI until deliberately reviewed), approval claims are tenant-bound with structured `TENANT_SCOPE_VIOLATION` logging, and the founder-approved ADR-003 `forShop` facade (two proof conversions live) is the migration direction (batches TS-1…TS-6, future). C-2 — the proof-of-pattern — is closed.

**Standard going forward:**
- Every new service-role query passes through a **shop-scoped query helper** (`forShop(shopId)` or Postgres session-variable + RLS-for-service-role) — mechanism, not discipline. Design in **P0-011**; adoption is mandatory for all new machine-path code once it lands.
- **D-018:** multi-user tenancy (members/roles/invitations, epic E01, phase P1) precedes major schema expansion. New tables designed after E01 must be written against membership-based policies, not `owner_id`.
- Every ticket's spec carries a **tenant-isolation impact** section and, where applicable, tenant-isolation tests (see `09-testing-strategy.md`).

## 3. Idempotency standard (D-023)

External provider events must be idempotent, enforced by **database uniques on provider event identifiers** — never check-then-insert.

| Surface | Provider key | State today | Ticket |
|---|---|---|---|
| Stripe webhooks | `stripe_ref` / invoice uniques | ✅ done — the reference pattern | — |
| Voice call records | UNIQUE `(shop_id, vapi_call_id)` | ✅ done | — |
| Inbound SMS | Twilio `MessageSid` | ✅ done — `provider_events` claim after signature verify (2026-08-14, PR #19) | **P0-005/P0-006** (done) |
| Inbound email | `aurinko_message_id` | ❌ none — `accountId:`-prefixed ids per ADR-001 C4 | Aurinko dedupe follow-up (backlog) |
| Voice minutes metering | Vapi call id as `usage_events` vendor_ref | ✅ done — durable unique (P0-005) + `provider_events` claim on the end-of-call route (2026-08-14, PR #21); tool-call events still un-deduped (backlog) | **P0-005/P0-007** (done) |
| Automation fires | `(automation_id, trigger_ref)` | ✅ done — partial unique landed with P0-005 (2026-08-13, PR #17) | **P0-005** (done) |

Rule for every new integration: identify the provider's event id before writing the handler; the unique constraint ships in the same migration as the table/column it protects.

### Provider facts & adoption gate (2026-07-27)

Vendor classifications (D-030) and per-provider outage behavior, failure fallback, idempotency, and event-identifier facts are normalized in `vendors/registry.md` (per-provider docs under `vendors/core|ai|transitional|customer-integrations/`). Adopting any new provider requires the 17-point gate in `vendors/README.md` — its security review, tenant-isolation analysis, and Gradia-owned abstraction boundary (D-029/ADR-002) are mandatory, not advisory.

## 4. Financial integrity (D-024)

- Ledgers (`usage_events`, `payments`, `credit_grants`, `shop_metrics`) are **append-only and immutable**; corrections are new offsetting rows, never updates/deletes.
- Audit found `usage_events`, `payments`, `shop_metrics` RLS is FOR ALL — **owner sessions could write their own billing/revenue rows.** ✅ Closed 2026-08-13: P0-005 (PR #17, migration `20260812130000`) flipped all three to SELECT-only for owner keys (the `credit_grants` pattern); the two legitimate session-client writers moved to service-role.
- Financial events must be **replay-safe**: metering keyed by vendor refs (P0-005 unique + P0-007 route wiring — done 2026-08-14), grants idempotent (already), reconciliation cron continues nightly.
- The cascade chain `auth.users → shops → ledgers` destroys financial/compliance history on delete. Soft-delete/archival is **P10** scope; until then, account deletion is a founder-manual operation, never self-serve.

### Transaction boundaries for money movement (added 2026-07-27)

The codebase today has essentially no multi-statement transaction usage (2 `.rpc()` call sites); multi-step flows rely on compensation/rollback-in-code (the approvals pattern). That is acceptable for staging drafts and leads. **It is not acceptable for money movement.** Standard, binding from E05 onward:

- Multi-step **financial writes** — deposit capture + quote state advance, invoice + payment recording, refunds, membership renewals (E06) — execute through an **atomic path**: a Postgres function/RPC or an equivalent single-transaction mechanism, so a mid-sequence crash can never record a payment without its ledger row (or vice versa).
- Compensation-only ("do step 2, undo step 1 on failure") flows are **not permitted** for money movement.
- This is an **E05 prerequisite**: the transaction mechanism is chosen (ADR) and proven in test before the first Connect ticket merges. Listed in E05 §Dependencies.

## 5. Secrets & crypto

- Per-shop credentials at rest: AES-256-GCM via `crypto.ts` (64-hex `ENCRYPTION_KEY`) — the required pattern for any new stored credential.
- Known exceptions to close: `a2p_registrations.business` holds EIN/legal identity in plaintext jsonb (backlog ticket, pre-scale); `shops` god-table exposes `*_enc` blobs to owner sessions (addressed by the `shop_connections` split, P1/E01 direction).
- Never commit secrets; `.env.example` documents every required var (5 missing vars fixed in **P0-010**). Prod and dev keys never shared. No secret values in logs, tests, or docs.

## 6. Webhook standards (locked)

All inbound webhooks: signature-verified, constant-time comparison, **fail closed** when secrets are unset, locked by `eval/webhooks.test.ts` (forgery/tamper/replay). This is a preserved invariant — extend the tests for new providers, never weaken. Plus, per §3, every webhook is idempotent by provider event id. Shop resolution comes from verified provider identifiers (number/assistantId/accountId/metadata), never from payload-supplied ids alone (the C-2 lesson).

## 7. Reliability standards

**Today's failure mode is quiet degradation:** pervasive `.catch(() => null)`, "pre-C1 tolerance" warn-and-continue, `recordUsage` never throws, console-only anomaly alerts, no queue/retry/dead-letter, zero `error.tsx` boundaries.

Standards going forward (bind on all new code; retrofits per roadmap):
1. **No new silent failure paths.** Failures either surface to the user, roll back (the approvals pattern), or emit an actionable structured log + alert. `.catch(() => null)` requires a written justification in the ticket.
2. **Alert delivery is real** — `monitoring.ts` anomalies, the `TENANT_SCOPE_VIOLATION` signal, reconciliation drift, and every cron failure emit through the ONE ops alert seam (`src/lib/alerts.ts`, **P0-012**, D-042) to the founder webhook (+ SMS for SEV-0/1); console-only alerting is non-compliant. The seam is fail-open (never breaks the caller), burst-deduped per instance, and self-reporting on `GET /api/health`. Unconfigured destination = console + Sentry only (the rollback position).
3. **Structured failure info:** every failure log/alert carries the fields in the convention below (P0-012); `[module]`-prefixed errors with shop_id and provider refs remain the floor; Sentry stays wired and cross-referenced by the seam; `GET /api/health` exists (P0-012); structured logger + tracing land in **P10**.
4. **No queue until P10** — accepted consequence: cron-tick retry granularity, weekly jobs without catch-up. Any ticket whose correctness depends on guaranteed delivery must say so and either use DB-unique idempotency (so replays are safe) or be deferred to the P10 outbox. **Event-processing bar for autonomy expansion (added 2026-07-27, roadmap rule 9):** E09 requires the P0 idempotency chain (P0-005/006/007) + P0-012 alerting complete; the P10 outbox is *not* the bar (founder-approved order runs P9 before P10), but every E09 ticket expanding autonomous execution on a webhook/cron path must state its idempotency basis explicitly.
5. **Error surfaces:** `error.tsx` at minimum at the `(dashboard)/` level (**P0-010**); loading/empty/error states per `12-definition-of-done.md`.
6. **Fail-closed remains the rule** for credits, entitlements, webhooks, and crons.

### Structured failure information — the convention (P0-012, 2026-09-01)

Binding for new code; enforced by review, not retrofit. A failure that is logged or alerted carries, in this order, whatever applies:

| Field | Where it goes | Rule |
|---|---|---|
| **module** | `[module]` log prefix · alert `source` | Stable, lowercase, path-like for routes (`cron/reminders`, `stripe/webhook`). |
| **severity** | alert `severity` | SEV-0..3 per `runbooks/incident-severity.md`; tenant isolation / money / consent start one level higher. |
| **what happened** | alert `title` (short, stable — it is the dedupe key) + `detail` | Numbers over adjectives. Sanitized: no secrets, no raw payloads, no headers, no signatures. |
| **shop_id** | `refs.shop_id` (or `authorized_shop` / `row_shop` for tenancy signals) | Always when a tenant is known; `ALL` for platform-wide. |
| **provider refs** | `refs.<provider>_ref` / `event_id` / `row` | Ids only — MessageSid, call id, event id, row id. |
| **action taken** | `refs.action` | What the code did: `refused — no write`, `sweep aborted`, `staged for approval`, `none`. |
| **retryability** | `refs.retryable` | `false`, or when/how: `next scheduled tick`, `provider retry`. |
| **exception** | alert `error` | Attached when one exists → captured in Sentry with the severity tag (cross-reference). |

Living examples: `reportTenantScopeViolation` (SEV-0), `detectUsageAnomalies` (SEV-1/2), `reconciliation.alertDrift` (SEV-1), `cron-run.reportCronFailure` (SEV-2). Fail-open rule: emitting an alert can never change the caller's outcome — the seam swallows its own failures and counts them (`/api/health` → `checks.alerts.failed`).

## 8. Data deletion & backups (gap, scheduled)

- No customer-data deletion/export flow exists (GDPR/CCPA-shaped gap); cascade-delete is the only path and it destroys ledgers. **P10** (soft delete, export, de-fanged cascades).
- DB backups/PITR are Supabase-platform settings, not inspectable from the repo — founder verification item (see `vendors/core/supabase.md`).

## 9. Prompt-injection posture

Defenses today are structural, not textual: forced tool_choice + zod schemas, read-only agent loops, no send tool in any loop (source-scan-tested), HITL staging on everything customer-facing, money/calendar ALWAYS_HITL. Residual risk concentrates where autonomy narrows review (Package-2 autopilot) and in the voice prompt (knowledge spliced verbatim). Hardening pass — delimiter/instruction-hierarchy, injection eval suite, extra scrutiny on autopilot-eligible drafts — is **P9/E09** scope. Until then: no expansion of autopilot-eligible action types without Organizer sign-off.

## 10. Incident readiness

Severity model SEV-0..SEV-3 and per-scenario procedures live in `runbooks/` (`runbooks/incident-severity.md` is the index). Risks feeding this posture are tracked in `risks/risk-register.md`. P0-012 wires the alert delivery that makes the runbooks reachable in practice.

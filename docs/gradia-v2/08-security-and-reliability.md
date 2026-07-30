# 08 — Security & Reliability

_Created 2026-07-25 by the Organizer. Grounded in the 2026-07-20 audit (`platform/docs/audit/06-security-and-tenancy-audit.md`, `05-database-audit.md`, `10-production-readiness.md`). Governs security and reliability requirements for all epics/tickets; the audit remains the layer-1 record of what is true today._

## 1. Security posture today (audited)

Audit scores: security **4/10** (capped by C-1), reliability **5/10**, observability **4/10**. Architecture alone would score ~7 — the deductions are operational.

### Findings → remediation map

| Finding | Severity | Summary | Remediation |
|---|---|---|---|
| C-1 | **CRITICAL** | Live Supabase Postgres superuser connection string (with password) committed at `.gitignore:46`, in pushed git history. Bypasses RLS and the app entirely. | **P0-001** (rotate today; scrub decision = decision queue) |
| C-2 | CRITICAL (dormant) | `claimPendingAction` has no shop binding under service-role; Slack interactivity path can execute any shop's approval. Mitigated only by `FEATURES.slackApprovals=false`. | **D-026** locks the flag off; shop-bound claims required before any re-enable (ADR + ticket, unscheduled). P0-011 designs the scoping helper that prevents the pattern. |
| H-1 | HIGH | `.env.local` plus four backup variants on disk — multi-copy leak hazard. | **P0-001** (consolidate/delete alongside rotation) |
| M-1 | MEDIUM | `processRawLeadNote` (`actions/ai-lead.ts:24`) unauthenticated, unmetered LLM call — cost/DoS amplifier. | **P0-010** |
| M-2 | MEDIUM | Agent `config` accepted as `z.unknown()` cast to `AgentConfig`, feeds audience queries/prompts. | **P0-010** (real zod schema) |
| L-1/L-2 | LOW | Missing `.eq("shop_id")` on two RLS-client mutations; one executor update unbound. | **P0-011** (sweep + helper adoption) |
| L-3 | LOW | Public quote token: uuid-derived (not CSPRNG-guaranteed), no expiry, no rate limit on `/q/[token]`. | **P0-009** (expiry enforcement) + follow-up ticket for randomBytes/rate limit (backlog) |

**Strengths to preserve (never regress):** uniform RLS on all 28 tables; all four provider webhooks signature-verified, timing-safe, fail-closed, test-locked; no text-to-SQL; no direct LLM-triggered side effects; money+calendar ALWAYS_HITL in code; AES-256-GCM for stored credentials; CSRF-protected OAuth.

## 2. Tenancy

**Today:** single-owner shops. RLS is the primary defense for session traffic (~69 modules on the anon/session client). **Service-role paths (~29–32 files: every webhook, cron, MCP, Slack, public quote) rely purely on `.eq("shop_id")` code discipline** — the DB will not catch a missed filter. C-2 is the proof-of-pattern.

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
| Inbound SMS | Twilio `MessageSid` | ❌ none — duplicate cards/spend on retry | **P0-005/P0-006** |
| Inbound email | `aurinko_message_id` | ❌ none | **P0-005** |
| Voice minutes metering | Vapi call id as `usage_events` vendor_ref | ❌ none — **double-billing** on retry | **P0-007** |
| Automation fires | `(automation_id, trigger_ref)` | ⚠️ code-side check only, race-prone | P0-005 foundation; unique index rides with it |

Rule for every new integration: identify the provider's event id before writing the handler; the unique constraint ships in the same migration as the table/column it protects.

### Provider facts & adoption gate (2026-07-27)

Vendor classifications (D-030) and per-provider outage behavior, failure fallback, idempotency, and event-identifier facts are normalized in `vendors/registry.md` (per-provider docs under `vendors/core|ai|transitional|customer-integrations/`). Adopting any new provider requires the 17-point gate in `vendors/README.md` — its security review, tenant-isolation analysis, and Gradia-owned abstraction boundary (D-029/ADR-002) are mandatory, not advisory.

## 4. Financial integrity (D-024)

- Ledgers (`usage_events`, `payments`, `credit_grants`, `shop_metrics`) are **append-only and immutable**; corrections are new offsetting rows, never updates/deletes.
- Audit found `usage_events`, `payments`, `shop_metrics` RLS is FOR ALL — **owner sessions can write their own billing/revenue rows.** Target: SELECT-only for owner keys (the `credit_grants` pattern). Rides with P0-011's scoping review (migration follow-up ticket if not absorbed).
- Financial events must be **replay-safe**: metering keyed by vendor refs (P0-007), grants idempotent (already), reconciliation cron continues nightly.
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
2. **Alert delivery is real** — `monitoring.ts` anomalies, reconciliation drift, and cron failures page the founder (**P0-012**); console-only alerting is non-compliant.
3. **Structured failure info:** `[module]`-prefixed errors with shop_id and provider refs; Sentry stays wired; structured logger + health endpoint + tracing land in **P10**.
4. **No queue until P10** — accepted consequence: cron-tick retry granularity, weekly jobs without catch-up. Any ticket whose correctness depends on guaranteed delivery must say so and either use DB-unique idempotency (so replays are safe) or be deferred to the P10 outbox. **Event-processing bar for autonomy expansion (added 2026-07-27, roadmap rule 9):** E09 requires the P0 idempotency chain (P0-005/006/007) + P0-012 alerting complete; the P10 outbox is *not* the bar (founder-approved order runs P9 before P10), but every E09 ticket expanding autonomous execution on a webhook/cron path must state its idempotency basis explicitly.
5. **Error surfaces:** `error.tsx` at minimum at the `(dashboard)/` level (**P0-010**); loading/empty/error states per `12-definition-of-done.md`.
6. **Fail-closed remains the rule** for credits, entitlements, webhooks, and crons.

## 8. Data deletion & backups (gap, scheduled)

- No customer-data deletion/export flow exists (GDPR/CCPA-shaped gap); cascade-delete is the only path and it destroys ledgers. **P10** (soft delete, export, de-fanged cascades).
- DB backups/PITR are Supabase-platform settings, not inspectable from the repo — founder verification item (see `vendors/core/supabase.md`).

## 9. Prompt-injection posture

Defenses today are structural, not textual: forced tool_choice + zod schemas, read-only agent loops, no send tool in any loop (source-scan-tested), HITL staging on everything customer-facing, money/calendar ALWAYS_HITL. Residual risk concentrates where autonomy narrows review (Package-2 autopilot) and in the voice prompt (knowledge spliced verbatim). Hardening pass — delimiter/instruction-hierarchy, injection eval suite, extra scrutiny on autopilot-eligible drafts — is **P9/E09** scope. Until then: no expansion of autopilot-eligible action types without Organizer sign-off.

## 10. Incident readiness

Severity model SEV-0..SEV-3 and per-scenario procedures live in `runbooks/` (`runbooks/incident-severity.md` is the index). Risks feeding this posture are tracked in `risks/risk-register.md`. P0-012 wires the alert delivery that makes the runbooks reachable in practice.

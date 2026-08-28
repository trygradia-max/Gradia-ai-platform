# 01 — Current State

_Created 2026-07-25 by the Organizer. This is a **condensation** of the 2026-07-20 technical audit (`platform/docs/audit/`, docs 00–14 + `gradia-audit.json`) taken on branch `home-redesign`. The audit directory is the precedence layer-1 record; when this summary and the audit disagree, the audit wins. When either disagrees with the code, the code wins._

## What the platform is

A **full-stack modular monolith** — Next.js 16 / React 19 / Supabase (Postgres + pgvector + Auth + Storage) on Vercel (audit 02):

- ~67k lines of strict TypeScript; `src/lib/` is a real domain layer (~90 modules) with vendor seams (`voice-provider.ts`, `telephony-provider.ts`, `crm-provider.ts`).
- **28 RLS-enabled tables across 54 idempotent migrations** (count corrected 2026-07-27); 2 private storage buckets; 2 pgvector RPCs (audit 05).
- **430 passing deterministic tests** including locking tests for every safety floor; 4 signature-verified provider webhooks (Twilio, Vapi, Aurinko, Stripe) (audit 03, 06).
- Live Stripe billing: $20 Core + $29 voice add-on, ledger-derived credits, fail-closed gates, nightly Twilio reconciliation.
- Two AI engines unified at the context layer: Anthropic chat/agent workflows (Haiku workers, Sonnet planner/loops) and a Vapi-hosted voice receptionist (`gpt-4o-mini`) (audit 07).
- **Single-owner-per-shop tenancy** — no members, roles, or invitations; multi-shop per owner via cookie switcher (audit 04-L, 06).
- The UI is honest: no mock data, fake metrics, or simulated features anywhere (audit 08).
- Classification: **private beta candidate**, overall production readiness **5.5/10** — architecture alone would score ~7; capped by the credential leak and reliability gaps (audit 10).

## What genuinely works (complete flows traced — audit 00, 04)

- **HITL approval engine** (`approvals.ts`) — atomic claim, edit-then-approve, undo, rollback-on-failure. The strongest subsystem; it *is* the universal AI action model.
- **Billing & metering** — checkout, webhook lifecycle, ledger credits, rollover grants, margin report, vendor reconciliation.
- **Inbound SMS pipeline** — signature-verified → identity → consent ledger → classify → staged lead + drafted reply.
- **Voice receptionist** — self-serve builder, synthesized prompt, 8 HITL tools, transcripts into shared memory, per-call glass-box records, budget fail-closed fallback.
- **CRM core** — customer identity spine, vehicles, 6-stage pipeline with timers, quotes with public accept page, jobs status machine, calendar + working hours.
- **Customer recovery import** — parse → LLM extract → dedupe → review → approve with undo → TCPA-gated eligibility (flag off; never live-smoked).
- **Shared brain** — pgvector memory + knowledge + one persona + one pricing module feeding voice, quotes, drafts identically.
- **Agent runtime** — one-shot planner → deterministic recipes/freeform executor with audience caps, cooldowns, consent gates, dry-run previews, 4-layer audit trail; Whisper routes through the same engine.

## Built but not complete (audit 00, 03, 04)

- **No conflict/availability check on any booking path** (voice, quote accept, drag, block-time); booking hard-requires Google Calendar via Aurinko (`approvals.ts:686`). Double-booking is possible today.
- **Quote acceptance forks a duplicate pipeline lead** (`approvals.ts:747`); quote status never closes; **expired quotes still acceptable server-side** (`quote-response.ts:82`).
- **Inbound webhooks are not idempotent** — no dedupe on Twilio `MessageSid` or `aurinko_message_id`; Vapi end-of-call retries duplicate transcripts and **double-meter voice minutes** (no `usage_events` vendor-ref uniqueness).
- **Delivery status dead for Gradia-provisioned numbers** — status callback resolves only BYO credentials (`api/twilio/sms/status/route.ts:75-83`).
- **Unified inbox is voice+SMS only, read-mostly** — no email channel, no in-thread reply.
- **Lifecycle derivation deliberately unwired** (`lifecycle.ts` on no cron) — win-back has no fuel pending founder threshold sign-off.
- **CI runs `npm test` only** — no typecheck, lint, or build; the DB-integration workflow quarantined `continue-on-error` since 2026-06-18; live-model evals gate nothing.
- **Two integrations unverified live:** A2P TrustHub SIDs (`twilio-a2p.ts:11`) and every Housecall Pro endpoint (`TODO(verify)`).
- Stale surfaces: receptionist catalog copy still describes the retired Slack flow; seven orphaned modules; zero `error.tsx` boundaries; four stale `revalidatePath` targets (audit 08).

## Most dangerous weaknesses (audit 00 §weaknesses, 06)

1. **C-1 (CRITICAL):** a live Supabase Postgres superuser connection string with password committed at `.gitignore:46`, in pushed git history. Bypasses RLS and the app entirely. → **P0-001.**
2. **C-2:** cross-tenant approval execution via the Slack path — `claimPendingAction` (`approvals.ts:209`) has no shop binding under service-role. Dormant only because `FEATURES.slackApprovals=false` (now locked by D-026).
3. **Duplicate-communication risk:** non-idempotent inbound webhooks + no conflict checks = duplicate cards, double voice billing, double-booking under normal provider retries. → P0-005/006/007, P0-003/004.
4. **Service-role tenant scoping is pure code discipline** across ~29–32 files; the DB will not catch a missed `.eq("shop_id")`. → P0-011.
5. **Quiet-degradation culture without alerting** — `.catch(() => null)`, console-only anomaly alerts; failures are silent by design and nobody is paged. → P0-010 (error surfaces — done 2026-08-28, PR #27) / P0-012 (alert delivery — still open; this weakness stays live until it lands).
6. **CI cannot stop a broken build reaching main = production.** → P0-002.

Also open: owner-writable financial ledgers (`usage_events`, `payments`, `shop_metrics` RLS FOR ALL — audit 05 §4, vs D-024), plaintext EIN in `a2p_registrations.business`, unauthenticated LLM-burning action (`actions/ai-lead.ts`, M-1), `.env.local` backup pile (H-1), quote-token hardening (L-3).

## Strongest foundations (build on, never rebuild — audit 00)

1. The approval/action system (`pending_actions` + one executor + resolution telemetry + decision log).
2. Guardrails-in-code discipline, test-locked (autonomy floors, send policy, TCPA/FTC, entitlements).
3. The billing/metering/reconciliation loop.
4. The shared brain (memory, knowledge, persona, pricing).
5. Provider seams + webhook signature verification (all four, timing-safe, fail-closed, test-locked).

## Branch state (home-redesign, 2026-07-25)

Home rebuild Phases 1–4 committed (`home-analytics` data layer is exemplary — every figure traced to rows); Phase 5 (verify) not done; `dashboard/page.tsx:59-106` still stacks the legacy tail per `HOME_REDESIGN_PLAN.md` item 9 (contradiction C-08). Untracked scratch at repo root (mockup, plan/handoff docs, `.playwright-mcp/`). Alpha date: **2026-08-07**; the audit's verdict stands: rotate the credential, then land the stabilization list (→ epic E00 / sprint 1) before any new feature work.

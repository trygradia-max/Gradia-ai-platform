> **⚠️ SUPERSEDED (banner added 2026-08-28).** This plan has been replaced. Do NOT work from it. Successor: `platform/docs/gradia-v2/` — roadmap `10-roadmap.md`, decisions `11-decision-log.md`, precedence `16-document-source-map.md`.

# Gradia — MVP Implementation Plan

_Authored 2026-06-01. Companion to `GRADIA_MVP_PLAN.md` (the build spec) and `MVP_GATING_PLAN.md` (the Phase-0 hide-pass detail). This doc is the engineering execution plan: what's already true in the code, the corrections that shrink the work, and the file-level changes per phase._

---

## 0. Pre-flight findings (verified against the clone, 2026-06-01)

Recon of `/Users/harryhatch/gradia-app` (canonical per founder decision; marketing site set aside) resolved the spec's open items and corrected several assumptions. **These corrections reduce scope.**

| Open item | Resolution |
|---|---|
| **#2 Canonical CRM** | Code has **only Jobber** (`jobber.ts`, `jobber-push.ts`). No HubSpot/Pipedrive/Make/Pipedream anywhere. **Jobber is the MVP CRM.** A second CRM is post-MVP. |
| **#3 Source of truth** | GitHub `origin/main` = this clone @ `0803c80`. Desktop copy was 1 commit ahead (marketing site, unpushed) with a clean tree. **Decision: build in the clone; marketing reconciled later.** |
| **#4 Framework** | Runtime is hand-rolled (Anthropic SDK + Zod), no LangGraph. **Extend the existing planner; do not adopt LangGraph for MVP.** |
| **#1 Credits** | Needs founder numbers; cost model built (`~/gradia-cost-model.html`). Phase 3 ships with documented defaults, tunable later. |

### Spec corrections from code reality (work that disappears)

| Spec / gating plan says | Reality in code | Effect |
|---|---|---|
| §8 "migrate off `claude-3-5-haiku-latest`" | Already on `claude-haiku-4-5-20251001` + `claude-sonnet-4-6` | **No migration needed** |
| Gating plan §4 "Add `src/middleware.ts` (none exists today)" | `src/middleware.ts` **exists** (auth `updateSession`); Next 16 **deprecated `middleware` → renamed to `proxy`** (confirmed in in-repo docs) | **Migrate to `src/proxy.ts`** and add the gate there |
| Spec P1 "re-home approvals in-app" | In-app approve/reject/edit **already executes** (`approveFromDashboard`, `approveWithEdits`, `rejectFromDashboard` in `actions/approvals.ts`) | P1 shrinks to: flag-gate Slack notifications + add in-app badge |
| Spec P4 voice persona | Vapi voice LLM is **`gpt-4o-mini`**, not Claude | Persona unification is via the Vapi system prompt, not a model swap |

---

## 1. Phase 0 — Subtraction / hide pass `[done]`

Low-risk, reversible. Detail in `MVP_GATING_PLAN.md`. File-level changes:

| # | File | Change |
|---|---|---|
| 0.1 | `src/lib/features.ts` *(new)* | Flag spine (spec §7) + `agentEnabled`/`integrationEnabled` helpers |
| 0.2 | `src/lib/data/agents.ts` | `return [...].filter(a => agentEnabled(a.id))` — hides `instagram`, `billing` |
| 0.3 | `src/app/(dashboard)/settings/page.tsx` | Filter `sections[]` + conditionally render `payments`/`instagram`/`facebook` `<section>`s via `integrationEnabled()` |
| 0.4 | `src/middleware.ts` → `src/proxy.ts` | Next 16 deprecated `middleware`, renamed to `proxy`. Migrate the auth file to `proxy.ts`/`proxy()` and add the gate: 404 `/api/meta/*` and `/api/stripe/connect/*` when flag off, before `updateSession`. Keep `/api/stripe/webhook` live |
| 0.5 | `src/lib/whisper.ts` + `src/app/api/whisper/process/route.ts` | Drop `charge_customer` intent (enum, schema, prompt, return union, route branch + `sendChargeApprovalRequest` import). Whisper = `create_lead | add_note` |

**Exit:** `npm run build` green; `/agents` hides IG/Billing; `/settings` hides IG/FB/Payments; `/api/meta/webhook` & `/api/stripe/connect/start` → 404; `/api/stripe/webhook` reachable; flag-flip restores a surface (reversibility proof).

---

## 2. Phase 1 — In-app approvals as default `[done]`

In-app approval **execution already exists** — this phase makes it the *default surface* and removes the Slack dependency.

- Wrap every `lib/slack.ts` send in `if (FEATURES.slackApprovals)`. Call-site inventory: `agent-runtime.ts`, `lib/approvals.ts`, `lib/vapi-tools.ts`, `actions/{outbound-email,outbound-sms,leads,approvals,co-owner,outbound-instagram,outbound-facebook}.ts`, `api/{aurinko/webhook,meta/webhook,slack/interactivity,cron/reminders,whisper/process,twilio/sms,stripe/webhook}/route.ts`, `lib/mcp/server.ts`.
- New migration `notifications` table (RLS by `shop_id`); insert one on each `pending_actions` insert.
- Dashboard nav badge/feed reading unread notifications.

**Exit:** with `slackApprovals:false`, an approval appears in `/approvals` + badge; Approve finalizes the real calendar/SMS/email action.

---

## 3. Phase 2 — Hybrid Chat agent (free-form planner) `[done]` — highest risk

- `agent-planner.ts`: extend the Zod plan schema so a plain-English ask resolves to **either** a known recipe (today's catalog) **or** a `freeform` shape `{ audience_query, message_template, channel, cadence }`.
- `agent-runtime.ts`: add a `freeform_outreach` executor — resolve audience (capped), draft per-customer (we/us, signed) via existing drafters, stage each as `pending_actions`. **Never sends directly.**
- Guardrails (spec §6) mandatory: always-HITL, audience cap 50 (configurable), dry-run preview, credit pre-check (full in P3), cooldown (reuse `stale_customer_sms` logic), STOP/opt-out honoring, audit via `agent-runs.ts`.

**Exit:** "text leads who quoted ceramic and never booked" → dry-run preview (count + 2–3 samples) → staged approvals, **zero direct sends** against a seeded test shop.

---

## 4. Phase 3 — Credits + paywall `[done — flag flipped 2026-06-09]`

> **2026-06-09:** new-signup defaulting landed (`20260609100000_shop_plan_default_free.sql` — `shops.plan` DEFAULT → `'free'`; existing shops stay grandfathered `'active'`), `FEATURES.paywall` flipped on, and the metering math is locked by `eval/credits.test.ts`. **Deploy steps:** apply the migration (`supabase db push`) and set `STRIPE_SECRET_KEY` / `STRIPE_PRICE_ID` / `STRIPE_WEBHOOK_SECRET` in the deploy environment before this ships.

- Migration: `usage_events` ledger + `shops` columns (`plan`, `stripe_subscription_id`, `credit_balance`, `credit_limit`, `credit_period_start`). RLS by `shop_id`.
- Subscription: Stripe Checkout for $20/mo; gate `(dashboard)/layout.tsx` on `plan === 'active'` (redirect to `/billing`). **Extend the existing `/api/stripe/webhook`** for `customer.subscription.*` (distinct from gated Connect).
- Metering: decrement on (a) agent run/plan — `agent-runtime`/`agent-planner`; (b) message **on send** — `lib/approvals.ts` executors; (c) **voice minute** — Vapi end-of-call webhook.
- Fail-closed at `credit_limit`: runtime + planner pre-check stops and notifies.
  - ⚠️ **Voice can't be cut mid-call cleanly** (real-time). Voice fail-closed is coarse: meter post-call, refuse to *answer the next* call when over limit.
- Default credit values (tunable, from cost model): 1 credit ≈ 1¢ API cost; message = 1, agent run = 1, voice = ~15/min; $20 includes ~1,000.

**Exit:** dashboard gated behind active sub; metered action decrements; hitting `credit_limit` fails closed.

---

## 5. Phase 4 — Brain unification (light) `[done]`

- One persona source (derive from `HUMAN.md`/a `persona.ts`) wired into **both** `vapi-prompt.ts` and the drafters; both read one knowledge base (`knowledge.ts`, already shared).

**Exit:** voice + chat produce identical tone from one source.

---

## Conventions enforced (spec §8)
we/us voice; HITL on every customer-facing action; signed outbound; read `node_modules/next/dist/docs/` before Next-API code; never commit `.env.local`; `main` = production. (Model migration already satisfied.)

## Verification cadence
Each phase ends green on `npm run build` + a manual smoke check. Before enabling the free-form planner in production, run against a seeded test shop and confirm zero direct sends.

# Gradia — MVP Rethink & Build Spec

> **SUPERSEDED 2026-09-03.** The single source of truth for what Gradia is and what gets built next is `platform/CONTEXT.md`. This file is history and detail reference only — do not plan from it.


_Authored 2026-06-01. This is the working source of truth for the refreshed MVP._
_Where this doc conflicts with `PROJECT_BRIEF.md`, **this doc wins** — the brief describes the original 7-agent vision and is kept for history._

---

## How to use this doc (read me first)

This is the build spec for trimming Gradia to a focused, shippable MVP and then building the few net-new pieces it needs. The guiding principle is **subtract, then unify** — most of what the MVP needs already exists in the codebase; the work is hiding what's out of scope and building three net-new capabilities (in-app approvals, a hybrid chat agent, credits + paywall).

**Golden rule, inherited from `PROJECT_BRIEF.md` and still in force:** Gradia speaks as _we/us_; every customer-facing action goes through human approval (HITL); outbound messages carry Gradia's name + role; never commit `.env.local`; `main` = production. And per `AGENTS.md`: this Next.js has breaking changes — read `node_modules/next/dist/docs/` before writing code.

**Nothing gets deleted.** Everything out of scope is gated behind feature flags so it stays dormant and reversible.

---

## 1. North star (one paragraph)

Gradia is a SaaS agentic AI office for independent auto detailers, from $20/month, sold as **two packages**. **Package 1 — Core ($20):** the headline product is **Gradia Agent** (one chat box that reads/segments the CRM and *acts on request* — find past + current customers, draft follow-ups/reminders/campaigns, create leads + notes, every outbound staged for approval) plus **Gradia Whisper** (speak an instruction, Gradia stages the action). Core is on-request and approve-first by design. **Package 2 — Voice + Chat Autopilot (+$29):** activates the already-built autonomous layer — a **Voice agent** (answers calls, quotes, books) and the **Chat agent running autonomously** (background outreach to old leads, follow-ups, reminders), unlocked by **Autonomous mode**. Every package shares one brain: the same memory, customer record, knowledge base, and persona; money + calendar writes always stay human-approved. It plugs into three things: **Calendar, CRM, and Email**. Pricing source of truth: `_docs/GRADIA_PRICING.md`.

---

## 2. Locked decisions (2026-06-01)

| Decision | Choice |
|---|---|
| Agents | **2** — Voice + Chat (Chat = the agentic runtime) |
| Features | **2** — Gradia Whisper, Agentic mode |
| Integrations | **3** — Calendar (Aurinko), CRM (Jobber), Email (Aurinko) |
| Chat agent's mind | **Hybrid** — keep recipes as guardrailed skills, add a free-form planner for one-off asks |
| Approval surface | **In-app `/approvals`** is the default; **Slack optional** behind a flag |
| Credit meter | **Itemized** — AI agent runs/plans **+** outbound messages **+** voice-call minutes |
| "One brain" scope (MVP) | **Shared data/persona/memory**, but **two execution engines** (Vapi real-time voice; agentic runtime for chat). A single unified reasoning mind is post-MVP. |
| Hidden for MVP | Instagram, Facebook, and the Billing (charge-customer-by-voice) agent |
| Kept | SMS (follow-up channel), Ask Gradia BI chat, Knowledge, Developer/MCP |
| Mechanism | Feature flags — one config, reversible |
| Packaging | **Reframed 2026-06-15:** **Package 1 — Core $20/mo** = Gradia Agent + Whisper (on-request, approve-first). **Package 2 — Voice + Chat Autopilot +$29/mo** = voice receptionist + autonomous Chat agent + Autonomous mode (activates already-built code on upgrade). |
| Price | **Superseded 2026-06-11:** Core $20/mo (1,200 message credits) + Package 2 $29/mo (number + 60 min + autonomy). Source of truth: `_docs/GRADIA_PRICING.md` |

### What this supersedes from `PROJECT_BRIEF.md`
- **7 agents → 2.** Email/SMS/booking become capabilities of the two agents + integrations, not standalone agents. Instagram/Facebook/Billing are hidden.
- **Slack-only HITL → in-app first.** Detailers don't live in Slack. Approvals move into the app; Slack stays optional behind a flag.
- **Whisper → billing → Whisper → notes/memory/tasks.** Matches the brief's *original* Phase-1 intent ("voice note → task"), and decouples Whisper from the now-hidden billing agent.
- **Chat agent is now an explicit product surface** (the autonomous CRM worker), not just a background cron.

---

## 3. Architecture: what exists vs. what to build

The keystone — the shared brain — **already exists**. `src/lib/memory.ts` is documented as _"the brain every channel reads and writes to."_ One `interactions` table with pgvector embeddings; every channel logs and recalls through the same primitives, including the cross-channel flag ("also emailed 2h ago").

| Component | Where | State | MVP action |
|---|---|---|---|
| Shared memory / brain | `lib/memory.ts`, `lib/embeddings.ts`, pgvector | ✅ Exists | Keep. The foundation. |
| Customer identity | `lib/customers.ts`, `customer-context.ts` | ✅ Exists | Keep. |
| Knowledge base (RAG) | `lib/knowledge.ts` | ✅ Exists | Keep — shared by both agents. |
| Persona (we/us, HUMAN.md) | `lib/vapi-prompt.ts`, drafters | ✅ Exists | **Unify** — both engines read one persona source. |
| Voice engine | Vapi + `lib/vapi-tools.ts` | ✅ Exists | Keep. Add credit metering on minutes. |
| Chat / agentic engine | `lib/agent-runtime.ts`, `agent-planner.ts`, `/api/cron/agents` | ✅ Exists, **on rails** | **Extend** — planner constrained to a recipe catalog today; add free-form planning. |
| HITL | `pending_actions` → `lib/slack.ts` | ✅ Exists, **wrong surface** | **Re-home** approvals in-app; Slack behind a flag. |
| Calendar / Email | Aurinko (`lib/aurinko.ts`) | ✅ Exists | Keep. |
| CRM | Jobber (`lib/jobber.ts`, `jobber-push.ts`) | ✅ Exists | Keep. Confirm Jobber is the MVP CRM (see Open items). |
| Whisper | `/api/whisper/process`, `lib/whisper.ts` | ✅ Exists, billing-coupled | **Repoint** to notes/memory/tasks. |
| Paywall + credits | — | ❌ Net new | **Build.** |
| Free-form planning | — | ❌ Net new (extends planner) | **Build.** |

---

## 4. The build, in phases

Phases are ordered so the low-risk subtraction lands first and each phase is shippable on its own.

### Phase 0 — Subtraction (the hide pass)
Low-risk, reversible. Full detail in `MVP_GATING_PLAN.md`. Summary:
1. Add `src/lib/features.ts` (see §7) as the single source of truth.
2. Filter the agent catalog in `src/lib/data/agents.ts` by `agentEnabled(id)`.
3. Gate the Instagram / Facebook / Payments cards + `sections` in `settings/page.tsx`.
4. Add `src/middleware.ts` to 404 disabled routes (`/api/meta/*`, `/api/stripe/connect/*`). **Keep `/api/stripe/webhook` live** — the paywall reuses Stripe.
5. Repoint Whisper off billing (Phase note below).

### Phase 1 — Approvals, in-app
Make `/approvals` the default HITL surface so a detailer never needs Slack.
- Route every `pending_actions` insert to surface in-app (the page already reads them) + an in-app notification/badge.
- Wrap all `lib/slack.ts` sends in `if (FEATURES.slackApprovals)` so Slack becomes optional, not required.
- Approve/Edit/Reject from the app finalizes the action (calendar event, send SMS/email) exactly as the Slack flow does today.

### Phase 2 — The hybrid Chat agent
Turn the on-rails runtime into the agent described in the north star.
- Keep the existing recipes (`lead_followup_sms`, `stale_customer_sms`, `appointment_reminder_email`, the event recipes) as **guardrailed skills** — they're the safe defaults.
- Extend `agent-planner.ts` so a plain-English ask resolves to **either** a known recipe **or** a **free-form plan**: `{ audience query, message template, channel, cadence }`.
- Add a `freeform_outreach` executor in `agent-runtime.ts` that runs a free-form plan: resolve the audience, draft per-customer messages (we/us, signed), stage each as a `pending_actions` approval. **Never sends directly.**
- Guardrails in §6 are mandatory for this executor.

### Phase 3 — Credits + paywall
The meter and the gate.
- **Subscription:** Stripe Billing/Checkout for the $20/mo plan, gating the `(dashboard)` layout behind an active subscription. Reuse `/api/stripe/webhook` for subscription lifecycle events. (Distinct from the hidden Stripe **Connect** flow, which charged the detailer's customers.)
- **Credit ledger:** decrement on each metered event — an agent run/plan, an outbound message (on send), and per voice-call minute (from the Vapi webhook). See §5.
- **Credit-limit setting:** a per-shop cap in `/settings`; when the balance hits the cap, the runtime and the Vapi webhook **fail closed** (stage nothing / end gracefully) and notify the owner in-app.

### Phase 4 — Unify the brain (light)
- Ensure both engines read **one** persona source and **one** knowledge base, so voice and chat sound identical and know the same facts. No new reasoning engine — just a single source for tone + knowledge wired into both `vapi-prompt.ts` and the drafters.

---

## 5. Data model additions (Supabase)

- `usage_events` — append-only ledger: `(id, shop_id, kind['agent_run'|'message'|'voice_minute'], quantity, credits, ref_id, created_at)`.
- `shops` new columns: `plan` (`free`|`active`|`past_due`), `stripe_subscription_id`, `credit_balance` (or derive from ledger), `credit_limit` (owner-set cap), `credit_period_start`.
- `notifications` (optional, Phase 1) — in-app approval/alert feed: `(id, shop_id, type, payload, read_at, created_at)`.
- All new tables RLS-scoped by `shop_id`, consistent with existing tables. Add as a numbered migration under `supabase/migrations`.

---

## 6. Guardrails for the free-form Chat agent (mandatory)

The free-form planner can query the whole customer base, so it ships with hard limits:
1. **Always HITL** — every drafted message stages a `pending_actions` approval. No exceptions, no "auto-send" toggle in the MVP.
2. **Audience cap** — default max **50** recipients per run, owner-configurable; over the cap, the plan is split and the owner is warned.
3. **Dry-run preview** — the agent builder shows the resolved audience count + 2–3 sample drafts before the agent is enabled.
4. **Credit pre-check** — estimate credits before drafting; if the run would exceed `credit_limit`, stop and notify.
5. **Cooldowns** — never re-contact a customer the agent already messaged within N days (reuse the existing cooldown logic in `stale_customer_sms`).
6. **Compliance** — honor SMS STOP/opt-out before staging any text; keep outbound signatures.
7. **Audit** — every run recorded via `agent-runs.ts`; every action traceable to its plan.

---

## 7. The feature-flag spine

`src/lib/features.ts` — single source of truth. Gate, don't delete.

```ts
export const FEATURES = {
  agents: {
    voice: true, chat: true, email: true, sms: true, booking: true, memory: true,
    instagram: false, billing: false, // hidden
  },
  integrations: {
    calendar: true, crm: true, email: true, sms: true,
    instagram: false, facebook: false, payments: false, // hidden
  },
  whisper: true,
  agenticMode: true,
  freeformPlanner: true,   // Phase 2 — flip on when the executor + guardrails land
  biChat: true,            // Ask Gradia
  slackApprovals: false,   // Phase 1 — Slack is now opt-in
  paywall: true,           // Phase 3
} as const

export const agentEnabled = (id: string): boolean =>
  (FEATURES.agents as Record<string, boolean>)[id] ?? false
export const integrationEnabled = (id: string): boolean =>
  (FEATURES.integrations as Record<string, boolean>)[id] ?? false
```

---

## 8. Conventions (enforced)

- **Voice:** Gradia is _we/us_, never _you and I_. Outbound email/SMS signed with Gradia's name + role.
- **HITL:** no billable or irreversible action without approval.
- **Next.js:** read `node_modules/next/dist/docs/` before writing code (per `AGENTS.md`) — APIs differ from training data.
- **Secrets:** never commit `.env.local`; `.env.example` is the template.
- **Branching:** `main` = production.
- **Models:** migrate off `claude-3-5-haiku-latest` (deprecation noted in the brief) to a current model string.

---

## 9. Build order & verification

**Order:** Phase 0 → 1 → 2 → 3 → 4. Each phase ends green on `npm run build` and a manual smoke check.

**Verification per phase:**
- **P0:** `/agents` shows no Instagram/Billing; `/settings` hides IG/FB/Payments; `GET /api/meta/webhook` → 404; flipping a flag back restores the surface (proves reversibility).
- **P1:** an approval appears in `/approvals` with Slack off; Approve finalizes the real action.
- **P2:** a plain-English ask ("text leads who quoted ceramic and never booked") produces a dry-run preview, then staged approvals — never an auto-send.
- **P3:** dashboard is gated behind an active $20/mo subscription; a metered action decrements credits; hitting `credit_limit` fails closed.
- **P4:** voice and chat produce identical persona/tone from one source.

**High-stakes verification:** before enabling the free-form planner in production, run it against a seeded test shop and confirm zero direct sends.

---

## 10. Open items for the founder

1. **Credit allotment & tiers** — $20/mo is set, but how many credits does it include, and what's a voice-minute worth vs. a message? Need numbers to finish Phase 3.
2. **Canonical CRM** — the brief lists Jobber + HubSpot + Pipedrive via Make/Pipedream; the code has Jobber direct. Is Jobber the MVP CRM, or do we need a second?
3. **Code source of truth** — confirm this GitHub clone is canonical and the Desktop working copy has no unmerged work, before any build begins.
4. **Agentic framework** — the brief names LangGraph.js; the runtime is hand-rolled. Recommendation: extend the existing lightweight planner for the MVP rather than adopt LangGraph now. Confirm.

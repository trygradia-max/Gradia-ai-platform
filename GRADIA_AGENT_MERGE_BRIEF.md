# Gradia Agent — The Merge Brief

> **Status:** Concept + risk register for review. Not yet a build order.
> **Owner-facing only.** This document is about the *owner copilot*, never the customer-facing receptionist.
> **Read first:** `GRADIA_MVP_PLAN.md`, `_docs/GRADIA_AGENT_SHARPENING_BRIEF.md` (locked principles), `_docs/GRADIA_UX_ONBOARDING_SPEC.md`, `_docs/GRADIA_PRICING.md`, `_docs/GRADIA_CUSTOMER_RECOVERY_SPEC.md` (TCPA).

---

## 1. What this is (the idea in one paragraph)

**Gradia Agent** is the shop owner's single chat box that can both **answer** questions about their business *and* **act** on their CRM/calendar on their behalf — e.g. *"find all my clients who have Teslas and send them a review request."* It is **not new AI brain**. It is the **fusion of two halves Gradia already shipped** but never joined:

- **"Ask Gradia" BI chat** — real-time conversational, **read-only** (8 read tools).
- **Custom agents** — can **act** (segment → draft → stage → send) but is **programmed once and runs on a schedule**, not conversational.

Gradia Agent = a conversational box that **reads like Ask Gradia and acts like a custom agent**, collapsing the multi-screen "build an agent" flow into a single chat turn, with an inline **count + cost + compliance + approve** card before anything sends.

### Non-negotiable framing (so we don't drift)
- The box is a **router into existing deterministic workflows**, NOT an open agent loop that improvises sends. (Locked principle #1.)
- Every **money and calendar write stays HITL**, no exceptions. (Locked principle #4.)
- The customer-facing **receptionist stays walled off** — it must never inherit the owner box's write tools.

---

## 2. What already exists (don't rebuild this)

| Capability | Where | Notes |
|---|---|---|
| NL → structured agent plan | `src/lib/agent-planner.ts` (`planAgentFromProblem`, Sonnet, forced tool call) | One-shot, outputs `AgentConfig`. **No loop.** |
| Audience resolution + guardrails | `src/lib/agent-audience.ts` (`resolveFreeformAudience`, `previewFreeformPlan`) | Whitelisted filters; cap 200/default 50; cooldown, opt-out, inactivity, recent-inbound gates; **dry-run preview with 3 sample drafts**. |
| Deterministic runtime | `src/lib/agent-runtime.ts` | 6 hardened recipes + freeform executor. Stages every send; never auto-sends a bulk blast. |
| Per-recipient drafting | `src/lib/sms-drafter.ts`, `email-drafter.ts`, `instagram-drafter.ts`, `facebook-drafter.ts` | Voice-grounded via `persona.ts`. |
| Draft critic | `src/lib/draft-verifier.ts` (`verifyBeforeStaging`) | Separate model flags objections pre-stage. |
| HITL staging + approval | `pending_actions` table → `src/lib/approvals.ts` (`executeApproval`) → `/approvals` UI | Approve / edit / reject. |
| Autonomy + hard locks | `src/lib/autonomy.ts` (`ALWAYS_HITL`, `isAutonomyAllowed`, `resolveAgentMode`) | book/reschedule/cancel/charge always HITL. |
| Read tools (BI) | `src/lib/bi-tools.ts` (8 read-only) + `/api/bi/chat` | counts, searches, pgvector memory, heat scores. |
| Metering | usage credits, 1 per draft, credit-limit pre-check | See `gradia-metering-billing` skill. |
| Compliance plumbing | `src/lib/twilio-a2p.ts` (A2P 10DLC), STOP detection (`looksOptedOut`) | SMS only; see risks. |

**The new work is glue + UX, not a rewrite:** a conversational surface that classifies intent, routes *action* intents through `planAgentFromProblem` → `previewFreeformPlan` → inline approval → existing staging, and routes *question* intents through the BI read tools — all in one box, one trust surface.

> **VERIFIED — "review requests, already written": only the engine.** There is **no review-request recipe** (catalog has 4: `lead_followup_sms`, `appointment_reminder_email`, `appointment_reminder_sms`, `stale_customer_sms`). Review requests currently fall through to the **generic freeform path** — no review-tuned copy, no review-platform link, no review-gating policy. The autonomous *delivery engine* is real (`maybeAutoExecute` auto-sends `send_sms`/`send_email` in autonomous mode; book/reschedule/cancel/charge stay ALWAYS_HITL). A review *feature* still needs building.

---

## 3. The merge architecture (target)

```
Owner types a request
        │
        ▼
[Intent classifier] ──"question"──▶ BI read tools (bi-tools.ts) ──▶ stream answer
        │
     "action"
        ▼
planAgentFromProblem  →  previewFreeformPlan (count + 3 samples + skip stats + COST + compliance)
        ▼
Inline approval card  ── reject/edit ──▶ back to owner
        │ approve
        ▼
Existing staging pipeline (pending_actions) → executeApproval → send
   (money/calendar → ALWAYS a second HITL gate, never auto)
```

Key rule: the conversational path **must use the shop-scoped client** (RLS-enforced), never a service-role client, and must always stage with **explicit in-conversation confirmation regardless of the shop's global autonomy setting.**

---

## 4. Knowledge / data coworking agents should go gather

Hand these to parallel agents to make the build flawless:

1. **Data-model truth for "my clients."** Map `customers` vs `leads` vs `interactions`. How many customers have a linked lead (`leads.customer_id` not null)? What % have phone/email? Where does vehicle data actually live and how complete is it? (Blocker — see Risk A.)
2. **Filter-capability inventory.** Enumerate exactly what `FreeformFilters` can express today vs. the query shapes a conversational box invites (spend, service type, vehicle year, location, recency-in-words). Produce the gap list. (Risk B.)
3. **Compliance state machine.** Document current consent model: do we capture *affirmative* marketing consent, or only detect STOP? Quiet-hours handling? A2P registration gating before send? Per-channel (SMS/email/IG/FB) consent rules. (Risk E — legal.)
4. **Autonomy interaction audit.** Trace whether a conversational stage could auto-fire under `autonomous` mode without the inline approval. (Risk D.)
5. **Eval coverage.** What eval cases exist? We need new ones for intent routing, capability grounding (honest refusal), and scope transparency. (Principle #6.)
6. **Cost/latency profile.** Real-time segment + draft N + verify N latency and credit/LLM cost vs. the scheduled path. (Risk F/G.)

---

## 5. Risk register (what could break "flawless")

Severity: 🔴 blocker · 🟠 major · 🟡 watch

### A. Data model & segmentation
- 🔴 **Vehicle data can't back the hero demo.** `customers` has **no vehicle field**; vehicle is free-text `car_info` on **`leads` only**, matched by `ilike '%tesla%'`. Misses "Model 3", "TSLA", typos; and "my clients" (customers) ≠ leads. **Decision needed:** add structured vehicle fields to customers, or reconcile leads→customers + accept fuzzy search.
- 🟠 **Leads↔customers join gap.** Many leads likely have `customer_id = null`, so vehicle on a lead may not attach to a customer. "Clients who have Teslas" silently under-returns.
- 🟠 **No tags/segments concept.** Filters are a fixed whitelist (`lead_status`, age, activity, `keyword`). Any other attribute (spend, service, location, vehicle year) is inexpressible.
- 🟡 **Contact coverage.** Customers missing phone/email are dropped silently; "all my clients" shrinks without explanation.

### B. Intent routing & NL understanding
- 🟠 **Read vs. act disambiguation.** "show me Tesla owners" (look) vs "message them" (act). Misclassification either acts unexpectedly or refuses to act. Needs a classifier + confirmation.
- 🟠 **Hallucinated capability.** The LLM will confidently agree to filters that don't exist ("sort by lifetime value"). Needs **capability grounding** so it honestly translates or declines.
- 🟠 **Compound/multi-step asks.** "text the Teslas, email the Audis" exceeds the one-shot `AgentConfig` schema. Decide: expand schema (evals-gated) or decline gracefully.
- 🟡 **Silent scope mismatch.** "send to all 500" becomes ~180 after cap(200) + cooldown + opt-out + inactivity. Must show *why* the number changed (the `AudienceStats` object already tracks skip reasons — surface it).

### C. Trust boundary & permissions (the merge itself)
- 🟠 **One box, two scopes.** Unified read+write surface must enforce shop scoping on **both**, via the shop-scoped (RLS) client — not the service-role client used in cron paths.
- 🟠 **Multi-user authority.** `requested_by` is the owner today. If staff use the box, who may approve sends/charges? Needs role gating.
- 🔴 **Receptionist wall.** The customer-facing receptionist must never share a tool surface/session with the owner box. The merge must not leak owner write tools into the receptionist path.

### D. HITL, autonomy & safety
- 🔴 **Autonomy bypass.** Verify a conversational stage can't auto-execute under global `autonomous` mode. Conversational actions must **always** require explicit in-chat confirmation.
- 🟠 **Bulk blast radius.** Even capped at 200, that's 200 real messages = money + reputation. Needs cost preview + explicit confirm, and a higher-friction gate above a threshold N.
- 🟠 **HITL fatigue vs. safety.** Instant for reads; one-tap approve for low-risk sends; hard gate for money/calendar. Don't "solve" friction by weakening principle #4.
- 🟡 **Idempotency.** Approve + network retry could double-send. Needs dedup keys.
- 🟡 **Critic objections inline.** `verifyBeforeStaging` objections must surface in-conversation without confusing the owner.

### E. Compliance / legal (highest non-engineering risk) — VERIFIED against code
> Verified state: in autonomous mode an SMS auto-fires after only THREE checks — A2P status, STOP opt-out (`looksOptedOut` regex), credit limit. No consent model, no quiet-hours. The gaps below are confirmed, not hypothetical.
- 🔴 **Opt-out ≠ consent (CONFIRMED).** No consent table/field exists; gating is STOP-word detection only (`agent-audience.ts` lines 67–70, 250–271). "Never opted out" is treated as "okay to text" — not the legal standard for marketing/review solicitation. Auto-send removes the human safety net, so this must be airtight in code. **Need an affirmative-consent model.**
- 🔴 **No quiet-hours / timezone logic anywhere (CONFIRMED).** `hour_of_day` only controls cron cadence (`agent-runtime.ts` 66–90), NOT send time. An autonomous agent can text at 3am local = flat TCPA violation. Blocker for unattended send.
- 🔴 **BYO-number A2P bypass (CONFIRMED, NEW).** `smsGateForShop` enforces A2P only for Gradia-provisioned numbers; a shop using its **own Twilio number returns `{ allowed: true }` unconditionally** (`telephony-provider.ts`). Auto-blast with zero carrier-compliance gating is possible. Close before unattended send.
- 🟠 **Review-gating (FTC/Google/Yelp).** Auto-sending review requests *selectively* (only happy customers / sentiment-filtered) violates platform policy + FTC. Auto-send to a whole segment is defensible; selective solicitation is not. Decide policy explicitly.
- 🟠 **Per-channel consent differs.** Email = CAN-SPAM unsubscribe; **IG/FB have a 24-hour messaging window** — can't freely message someone who hasn't messaged in 24h without a tagged/paid template. Code has **no STOP check or 24h-window handling for IG/FB.** Treating channels uniformly = policy violations.

### F. Cost & metering
- 🟡 **Credit burn via exploration.** Conversational "draft it for everyone so I can see" could waste credits. Preview already samples 3 — keep previews cheap; only meter on real stage/send.
- 🟡 **Box LLM cost.** Real-time tool-using chat on Sonnet > one-shot planner. Route reads to a cheap model, planning to Sonnet (principle #7).

### G. UX & product
- 🟠 **Blank-box intimidation.** Owners won't know what to type. Needs suggested prompts/capability chips (ties to UX spec: "every owner card has an owner-clickable action").
- 🟠 **Latency.** Segment + draft N + verify N is slow for a "now" interaction. Needs streaming/progressive feedback ("Found 23… drafting samples…").
- 🟡 **Inline edit.** Owner must tweak copy before send (the `/approvals` UI supports edit; the chat flow needs it too).
- 🟡 **Explainability.** Show *why these N* and *who was skipped and why* to build trust (`AudienceStats` already has the data).

### H. Architecture / principle adherence
- 🔴 **Principle #1 drift.** Under "make it do anything" pressure, the temptation is a generic tool-using loop. Stay a router into deterministic recipes/freeform.
- 🔴 **Principle #4.** charge/book/reschedule/cancel always HITL — the box must not bypass.
- 🟠 **Planner ceiling.** `AgentConfig` is a fixed schema; conversational asks will exceed it. Expand carefully, evals-gated (principle #6).
- 🟠 **Eval coverage.** New prompt surface (intent routing, refusal, transparency) needs eval cases before ship.

### I. Observability / ops
- 🟡 **Audit trail.** Log conversational origin (who asked, approved by whom) on `pending_actions`.
- 🟡 **Partial failures.** 10 of 23 SMS fail — surface the partial result back into the conversation.

---

## 6. Scope decision — channels narrowed

**Removed from product scope:** Instagram DM, Facebook DM, and the `charge_customer` agent action (shop billing its own end-customers).
**Explicitly KEPT:** platform billing (Stripe subscription + credits + `usage_events` metering) — that is Gradia's own revenue engine and is unrelated to `charge_customer`.

Channels Gradia Agent acts on are now: **SMS, email, calendar.** This is a *feature*, not a loss — it deletes the IG/FB 24-hour-window compliance problem (Risk E) entirely and shrinks the safe-send surface to two well-understood channels.

> **Offer/discount knock-on:** with `charge_customer` gone, the offer primitive can't auto-charge a discounted amount. Offers become **promo code / promo text**, optionally attributed at booking time — never a charge. (Option B-plus, not Option A.)

---

## 7. Target architecture — three layers (the loop lives in exactly one)

Do **not** build one all-powerful agent loop (that's the principle-#1 trap). Build three layers; the loop is only the middle one.

```
CONTEXT / RAG LAYER (shared, read-only)
  • Structured store (customers, leads, appointments, spend) → queried by TOOLS (SQL-backed: counts, segments)
  • Unstructured store (interactions + knowledge, pgvector) → queried by RAG (search_memory, search_knowledge)
      ▲ tools
CONVERSATION LAYER (THE agent loop — bounded)
  • owner msg → LLM with tools → reason / clarify / PROPOSE
  • tools = read (RAG + structured) + stage_action  (NO `send` tool exists)
  • loop ends by proposing; it can never execute
      ▼ stages into
EXECUTION LAYER (deterministic workflow — NO loop)
  • segment → draft → HITL preview → approve → send
  • ALL guardrails live here: consent, quiet-hours, caps, A2P
```

**Why the split:** the owner's *intent* is genuinely unknowable in advance → a bounded tool-using loop is justified there (principle #1 satisfied). A *send* is perfectly knowable → it stays a deterministic, guardrailed workflow. The loop has **no `send` capability, only `stage_action`** — guardrails live in tool capability, not the loop's prompt (principle #2).

**RAG rule that keeps it precise, not vibey:** structured/segmentable questions ("find Teslas", "booked this month") go through **tools over real columns**, never vector search. RAG is only for genuinely unstructured recall ("what did Sam ask about?", "what's our cancellation policy?"). Vector-searching a segment will silently add/miss people and destroy trust.

---

## 8. What the owner must integrate (the agent's fuel)

The agent is only as capable as the integrations completed and as trustworthy as the *structure* of the data given.

- **Tier 0 — Identity & knowledge** (typed in onboarding): name, services menu (name/price/duration), hours, policies, FAQs → persona + RAG knowledge base.
- **Tier 1 — Customers** (the CRM it acts on): captured live by voice/chat, or imported (CSV / contacts / inbox). *Structure is decisive here — clean vehicle/service/last-visit fields are what make segmentation possible.*
- **Tier 2 — Channels** (each consent-gated): **SMS** (Gradia number + A2P, or BYO + register), **Email** (Gmail via Aurinko), **Calendar** (Google via Aurinko).
- **Consent ledger** — who opted in. *Missing today; required before any send.*

---

## 9. Generality — the capability registry

General intent → segment → action engine, grounded by a **declared, finite registry** (general *within* it; honest refusal outside it):

**Segment dimensions:** lead_status · age · inactivity · recent-inbound · keyword *(today)* → **add:** booked-in-date-range, service type, period spend, structured vehicle (make/model/year), last-visit recency.

**Action types:** send_sms · send_email · create_lead · add_note *(today)* → **add:** review_request (first-class), offer/promo-code (no charge), announcement/blast. *(send_instagram_dm, send_facebook_dm, charge_customer — REMOVED.)*

---

## 10. Sequenced build plan

Trust-critical work lands before the box reaches an owner — dream outcome and churn outcome share the same code path; only sequencing separates them.

**Phase 0 — Removal & cleanup**
- **R1 · Remove IG/FB + `charge_customer`.** Delete drafters, outbound tools, action handlers; edit shared enums/UI/tests so it compiles. Preserve platform billing. (Map first; confirm git recoverability.)

**Phase 1 — Trust & Safety (BLOCKERS)**
- **B1 · Structured segment/vehicle data** — structured fields + leads↔customers reconcile + fix capture path + backfill `car_info`.
- **B2 · Safe-send guardrails** — quiet-hours/timezone windows, affirmative-consent model, close the **BYO-number A2P bypass** in `smsGateForShop`.
- **B3 · Review-gating policy** — no selective/sentiment-filtered review solicitation (FTC/Google).

**Phase 2 — Generality**
- **G1 · Segment registry** (booked-in-range + structured vehicle first).
- **G2 · Action registry** — first-class `review_request` + offer/promo-code primitive (no charge).
- **G3 · Capability grounding** in the planner — propose only registry-backed segments/actions; honest refusal otherwise.

**Phase 3 — The box (glue + UX)**
- **U1 · Unified read+act surface** (one shop-scoped/RLS endpoint; intent classifier → read tools or plan→preview→stage).
- **U2 · Inline preview/approval card** (count + cost + compliance + who-skipped-and-why; always explicit confirm).
- **U3 · Single-turn flow + suggested-prompt chips.**

**Phase 4 — Verification**
- **V1 · Evals + locking tests** (intent routing, capability grounding/refusal, transparency; extend HITL/consent locks).

> Real new work is **Phase 1 (trust/safety)** and **Phase 2 (registry + offer primitive)**. Phases 0 and 3 are mostly removal and glue over shipped infrastructure.

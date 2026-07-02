# Gradia UI/UX Redesign Spec

**Direction:** calm neutral base + one accent. Gradia is a trust product — an AI answering a shop's customers. The UI must read as a reliable instrument panel, not a toy.

**Research basis:** monday.com's open-source Vibe design system (token values read from their repo, not guessed), Linear/Stripe/Attio pattern analysis, Intercom Fin + Smith.ai + Goodcall for glass-box agent UX, Microsoft HAX guidelines and NN/g. Sources cited inline. Third-party teardown values are marked as such.

> **⚠️ AMENDED 2026-07-02 (Layer 0 decisions).** Sections marked **SUPERSEDED** below are overridden by **§8 Amendments**. On any conflict between §1–§7 and §8, **§8 wins.** Key reversals: the app ships **dark-first** (not light); typography is **Geist/Geist Mono** (not Inter); **Approvals stays a top-level page**; the **⌘K/Whisper command bar is the primary composer** (not a nice-to-have).

---

## 1. What we take from Monday — and what we deliberately don't

**Take:**
- Two-layer token architecture: primitive colors mapped to semantic aliases, every interactive color shipping `-hover` and `-selected` companions (Vibe `colors.json`).
- A pixel-named spacing scale on a 4px grid (`--space-4` … `--space-64`).
- Small radius set: 4 / 8 / 16px.
- Motion split into "productive" (70–150ms, functional feedback) vs "expressive" (250–400ms, celebrations).
- Inline editing as a system primitive (Vibe's `EditableText`/`EditableHeading`) — click any name/label to rename it.
- Undo button + Cmd/Ctrl+Z as a first-class board control, with a toast on every background action.
- Onboarding that produces **real data, not dummy data** — Monday's signup wizard builds your actual first board (Ojasild teardown).
- Guidance primitives baked into the component library: EmptyState, Toast, AttentionBox (inline callout), coach marks, MultiStepIndicator.

**Don't take (Monday's documented failures):**
- Rainbow status colors everywhere → their #1 criticism is visual overload at scale (Cloudwards, Forbes Advisor).
- No density control despite years of user requests.
- Notification/inbox overload — users drown in updates.
- 232-slide onboarding weight.

## 2. Design tokens

Single source of truth. No component may reference a raw hex — semantic tokens only. Implement as CSS variables (or Tailwind theme extension mapping to them).

### 2.1 Neutrals (the app is ~95% these) — **SUPERSEDED by §8-A1: the app ships DARK-first.** The table below is retained as the *deferred light theme*; the shipping dark values are specified in §8-A1.

| Token | Light value | Role |
|---|---|---|
| `--bg-canvas` | `#FAFAFA` | App background |
| `--bg-surface` | `#FFFFFF` | Cards, panels, table rows |
| `--bg-raised` | `#FFFFFF` + shadow-sm | Popovers, dropdowns |
| `--bg-sunken` | `#F4F5F7` | Sidebar, input wells (Attio-style nav separation — third-party observed) |
| `--bg-hover` | `#F0F1F3` | Row/item hover |
| `--bg-selected` | accent at 8% opacity | Selected row/nav item |
| `--border-default` | `#E4E5E9` | Hairline 1px borders |
| `--border-strong` | `#C9CBD1` | Inputs, focused containers |
| `--text-primary` | `#1A1B1E` | Headings, body |
| `--text-secondary` | `#6B6D76` | Metadata, labels, captions |
| `--text-tertiary` | `#9A9CA5` | Placeholders, disabled |

Elevation via 1px borders + soft shadows, never colored fills (Linear/Attio pattern). Shadows: `--shadow-sm: 0 1px 2px rgba(0,0,0,.05)`, `--shadow-md: 0 4px 12px rgba(0,0,0,.08)`, `--shadow-lg: 0 12px 32px rgba(0,0,0,.12)`.

### 2.2 Accent — exactly one

**Brand palette (decided): purple / black / silver / white.** Mapping onto the token system — this does NOT mean purple everywhere; purple is the one rationed accent, the other three ARE the neutral system:
- **White** → `--bg-surface`, `--bg-canvas` family
- **Silver** → the border tokens and `--text-secondary`/`--text-tertiary` range (§2.1 values are the silver scale)
- **Black** → `--text-primary` (near-black `#1A1B1E`, softer than pure black on white)
- **Purple** → `--accent`, below

| Token | Value | Notes |
|---|---|---|
| `--accent` | **`#7C3AED` (RESOLVED 2026-07-02)** — the marketing repo's current purple, verified identical to the fallback; passes WCAG AA for white button text at ≈5.7:1 | Primary buttons, links, focus rings, active nav — nothing else |
| `--accent-hover` | one shade darker | |
| `--accent-subtle` | accent at 10% | Selected states, badges |

Contrast check required: the chosen purple must pass WCAG AA (4.5:1) as white-text-on-purple for buttons; if the marketing purple fails, darken the UI variant and keep the brand purple for non-text uses.

Rule (Linear): one accent-colored primary action per screen. If two things are blue, neither is the call to action.

### 2.3 Semantic status — reserved strictly for meaning

| Token | Value | Meaning in Gradia |
|---|---|---|
| `--status-success` | `#00854D` (Vibe positive) | Call handled, appointment booked, payment ok |
| `--status-warning` | `#B45309` | Needs review, low confidence, credits low |
| `--status-danger` | `#D83A52` (Vibe negative) | Escalated/failed call, missed lead, billing failure |
| `--status-info` | `--accent` | AI-in-progress, informational |

Each ships a `-bg` companion (color at 10–12%) for badges. These colors appear ONLY on status. Never decoration. This is the hybrid of Monday's "color is data" insight inside a neutral shell.

### 2.4 Typography — **SUPERSEDED ENTIRELY by §8-A2 (Geist / Geist Mono; Inter is NOT introduced).**

~~Font: **Inter** (variable) with system-ui fallback.~~ See §8-A2. Retained from this section: hierarchy via weight and color, not size jumps (Stripe/Linear pattern); the closed 6-size scale 12 / 13 / 14 (body default) / 16 / 20 / 24 with line heights 16 / 18 / 20 / 22 / 28 / 32; weights 400 body / 500 emphasized-labels / 600 headings, nothing bolder; `font-variant-numeric: tabular-nums` for metric/table numbers.

### 2.5 Spacing, radius, motion

- Spacing: closed set only — 4, 8, 12, 16, 24, 32, 48, 64. No arbitrary values.
- Radius: `--radius-sm: 6px` (inputs, buttons), `--radius-md: 10px` (cards), `--radius-lg: 16px` (modals). Full-round for avatars/pills only.
- Motion: 100–150ms ease-out for all functional feedback (hover, open, toast); 250–400ms only for onboarding/celebration moments. Respect `prefers-reduced-motion`.
- ~~Dark mode: define tokens now even if you ship light-only~~ **INVERTED by §8-A1:** dark ships; *light* tokens are defined now (the §2.1 table) and deferred.

## 3. App shell & navigation

- **Fixed left sidebar**, `--bg-sunken`, collapsible. Workspace/shop switcher top-left (universal SaaS convention — Notion, Linear, Attio).
- ~~A shop owner has ~5 daily destinations.~~ **Sidebar list SUPERSEDED by §8-A4** (Approvals stays top-level). Final sidebar:
  1. **Home** (dashboard)
  2. **Approvals** (badge = pending count)
  3. **Activity** (glass box — the agent feed)
  4. **Conversations** (calls + SMS/chat, unified)
  5. **Customers**
  6. **Receptionist** (agent builder/settings)
  — then pinned at bottom: **Numbers & Billing**, **Settings**. Everything else lives inside those.
- Top bar: page title, search, usage pill in **human units** ("~200 texts · ~20 calls" — credits in fine print, per the UX-onboarding rename map; links to billing), help. No secondary nav rows.
- ~~Cmd+K command palette: nice-to-have layer~~ **SUPERSEDED by §8-A4:** the ⌘K/Whisper command bar is the **primary composer** (Focus-spec NOW-4 stands). Retoken it; do not demote or rebuild it. It is still never the *only* path to any action (owners are non-technical).

## 4. Screen-level UX rules

**Dashboard (Home)** — **AMENDED by §8-A5.** Answers "is everything OK?" in one glance (Stripe pattern). Final composition, top to bottom: **1) ROI receipt pinned on top** (sacred per the Focus spec — conservative, traceable, written zero-state) → **2) KPI sparkline row** — *Calls handled today · Leads captured · Appointments booked · Needs your review* (the last links to Approvals) → **3) recent Activity module.** Not a wall of charts. The existing co-owner nudge cards come **off** Home (§8-A8).

**Conversations:** list rows show caller, time, one-line AI summary, outcome badge (semantic color), AI/human flag. Skeleton rows while loading, never spinners for page loads (Carbon loading pattern).

**Receptionist builder:** progressive disclosure (NN/g). Default view = the 5 things every owner sets (greeting, hours, services, escalation number, tone). Everything else behind "Advanced". Persona/voice/chat settings edit in place with optimistic UI + undo toast.

**Empty states teach, never blank** (NN/g): "No calls yet — forward your number to go live" with the CTA button, not an empty table. Distinguish first-use vs no-results vs all-done.

**Feedback on every mutation:** optimistic update immediately, toast with Undo where reversible, visible rollback + error if the write fails. Silent failure is forbidden.

**Density:** comfortable default, but build a compact toggle for tables from day one — Monday's most-requested missing feature.

## 5. Glass Box — the Gradia Agent transparency layer

This is the differentiating feature. Backbone: Microsoft HAX G11 ("make clear why the system did what it did"), Shape of AI "Footprints", Intercom Fin's source attribution, Smith.ai/Goodcall call-record canon.

### 5.1 Activity Feed (new top-level page + dashboard module)
Reverse-chronological feed of everything the agent did. **Not a notification center** — routine wins log quietly, exceptions surface loudly (HatchWorks agent-UX pattern). Each entry:
- What happened: "Answered call from (555) 201-4437 · booked oil change for Fri 10am"
- Outcome badge (semantic color) + AI/human-handled flag
- **The "because" line — decision log, not action log:** "Offered Friday because Thursday was fully booked in your calendar." One sentence, plain English.
- Timestamp, expandable to the full record.
Filters: Needs review / Handled / Escalated / All. **Per §8-A4:** the "Needs review" filter **deep-links to the top-level Approvals page — it never duplicates it.** Pending-count badge lives on the Approvals nav item.

### 5.2 Call/Conversation record (the reviewable artifact — Smith.ai/Goodcall canon)
Every handled call or thread becomes: **summary on top → structured outcomes (caller type, intent, actions completed: booked / lead captured / message taken) → full transcript → audio playback → what shaped this** (which KB article, business-profile field, or rule the agent used — Intercom Fin citation pattern). The citation is the correction loop: "wrong Saturday hours" becomes "fix the hours field" (link straight to that setting), not "the AI is broken."

### 5.3 Needs-review queue (human-in-the-loop)
Consequential actions (send follow-up SMS, offer discount, refund, anything irreversible) queue as one-tap approvals. Three buttons: **Approve / Edit & approve / Dismiss** — binary approve/reject fails; owners must be able to fix the 10% that's wrong (Zapier/Microsoft Foundry HITL pattern). Routine FAQ handling never queues.

### 5.4 Confidence — qualitative, never percentages
Low-confidence handling gets a quiet amber "Review this" flag; high-confidence logs normally. No "73% confident" — raw numbers mislead non-technical users (aiuxdesign.guide, Smashing agentic-AI patterns). Rule: never present uncertain output with the same visual confidence as certain output.

### 5.5 Action receipts
Every agent-initiated change (booking created, SMS sent, customer record updated) renders a receipt row: what changed, when, under which rule — with Undo where reversible. "I can always see it and often undo it" is what makes delegation feel safe.

### 5.6 Push, don't only pull
Owners live in email/SMS, not dashboards (Smith.ai): per-call summary notification (configurable) + end-of-day digest ("12 calls handled, 3 bookings, 1 needs you"). Digest links into the feed.

### 5.7 AI disclosure
Setting for the agent to identify itself as AI to callers (legal requirement in some jurisdictions — verify for your markets; not researched here), and every record flags AI vs human handling (Intercom disclosure controls, Smith.ai flag).

## 6. Explicit non-goals for this pass

No mobile app work (but the existing mobile composer/Whisper surface is retokened, not removed — §8-A4), no marketing site, no new agent capabilities — presentation and transparency of what exists. No localization pass. ~~Dark mode: tokens defined, shipping deferred~~ → **Light mode: tokens defined, shipping deferred (§8-A1).** Post-alpha cuts listed in §8-A9.

## 7. Key sources

Vibe tokens: github.com/mondaycom/vibe (`colors.json`, `spacing.scss`, `typography.scss`, `motion.scss`) · Linear: linear.app/now/how-we-redesigned-the-linear-ui · Stripe UX analyses (third-party) · Attio teardowns (third-party — values marked observed) · Intercom Fin: intercom.com/help articles 7120684, 9929230, 11712008 · Smith.ai call intelligence docs · Goodcall.com · NN/g: empty states, progressive disclosure, AI hallucinations · Microsoft HAX Toolkit (18 guidelines) · Shape of AI (Footprints, Citations) · Smashing Magazine agentic-AI + AI-transparency patterns (2026) · HatchWorks agent UX patterns · Monday onboarding teardown (Ojasild) · Cloudwards Monday review.

---

## 8. AMENDMENTS — Layer 0 decisions (2026-07-02, founder-decided; these win over §1–§7)

### A1 — Dark stays. Light is the deferred theme.
The app does **not** flip to light. §2.1 is rewritten as a dark-first token system keeping the calm-neutral discipline:
- **Canvas & surfaces:** near-black warm — derive exact values from the existing dark palette in `platform/src/app/globals.css` (already near-black warm OKLCH); lock the chosen values in the Layer 1 commit. Elevation still via hairline borders + soft shadow, never colored fills.
- **Silver scale** → borders and secondary/tertiary text (dark-adapted equivalents of the §2.1 silver roles).
- **White** → primary text.
- **ONE accent: purple `#7C3AED`** — replaces coral **everywhere**. Same rationing rule: one accent-colored primary action per screen.
- **Semantic status colors** (§2.3) reserved strictly for status; verify each passes contrast on the dark canvas in Layer 1.
- The §2.1 light table is **retained as the deferred light theme** — defined, never shipped this phase.
- **Grain/mesh/glass/cinematic layer:** stripped from **all dashboard surfaces**. May remain on public pages only (`/`, `/how-it-works`, `/login`, `/onboarding`).

### A2 — Typography: Geist system. §2.4's Inter is dead. No new fonts.
- **Geist** (already installed) is the single UI family. Weights: 400 body / 500 labels-emphasis / 600 headings. Nothing bolder.
- **Geist Mono for every number that matters:** KPI values, money, credits, durations, phone numbers — `tabular-nums`, always.
- **Closed 6-size scale in the dashboard:** 12 / 13 / 14 / 16 / 20 / 24, **fixed sizes** — no `clamp()` inside the app. Public pages may keep responsive hero sizing.
- Hierarchy via weight and text color (primary/secondary/tertiary), not size jumps.
- **Instrument Serif is retired app-wide**, including `section-header`. **Do not introduce Inter. Do not introduce any new font.**

### A3 — Voice: narrator vs character.
- **UI chrome** speaks the Language Pack voice: third person, "your receptionist" / "Gradia", numbers over adjectives.
- **Anything the agent itself authored** — chat bubbles, outbound message previews, transcripts — stays in its eval-locked **we/us** voice, untouched. `persona.ts` is no-touch.
- Chrome strings currently in we/us get renamed to chrome voice (e.g. "Waiting on us" → "Waiting on your receptionist").
- Rationale: the agent is a **character**; the UI is the **narrator** describing it. Coherent, not split.

### A4 — Navigation: final IA (ends the four-map fight).
- **Approvals is load-bearing and stays top-level.** §5.1's fold-into-Activity is superseded; Activity's "Needs review" filter **deep-links to Approvals, never duplicates it.**
- Sidebar exactly: **Home · Approvals (badge = pending count) · Activity · Conversations · Customers · Receptionist** — pinned bottom: **Numbers & Billing · Settings**.
- Consolidations: `agent` + `agents` + `agents/build` → **Receptionist**; `chat` (Ask Gradia BI) → **Conversations**; `leads` + `recovery` → **Customers** (recovery as a flow within customer context); `schedule` → **home to be proposed in the Layer 2 plan before building**.
- **⌘K/Whisper command bar remains the primary composer** (Focus-spec NOW-4 stands). Retoken, don't demote or rebuild.

### A5 — Home composition.
Top to bottom: **ROI receipt pinned at top (sacred)** → KPI sparkline row (*Calls handled today · Leads captured · Appointments booked · Needs your review* → links to Approvals) → recent Activity module. Existing co-owner nudge cards come **off** Home (they violate the Language Pack §4.4 guardrails); nudges return post-alpha inline-in-context via the engine (A8).

### A6 — Glass Box backend: narrow additive writes APPROVED, with fences.
**Allowed:**
- (a) Persist the Vapi end-of-call report currently dropped in `api/vapi/webhook/route.ts` — **summary, duration, cost, ended_reason** — into a proper per-call record (new table or columns; follow existing RLS/`shop_id` conventions).
- (b) Add a **decision-log write where actions are staged** (`agent-runtime.ts` / `vapi-tools.ts` writing WHY into `pending_actions` or a sibling table).

**Fences:** both writes are wrapped so any capture failure can **never** break call handling or billing — capture is best-effort, calls are not. Still absolutely no-touch: `usage_events`, `credits.ts`, `pricing.ts`, anything Stripe, Twilio webhooks, `persona.ts`, agent decision behavior.

**Sequencing:** these writes land **FIRST, before Layer 1** ("Layer 0.5" / data-capture commit) — every day uncaptured is data lost forever. Ships with a test proving a failed capture doesn't fail the webhook.

### A7 — Dependencies & sourcing (amends COMPONENT-SOURCING-MAP).
- **Recharts approved** (for Tremor copy-paste components, Layer 3).
- **21st.dev membership: SKIP.** The ~78 existing components cover the sourcing map.
- The map's fresh-init / Rhea-style / destination-path assumptions are **superseded by repo conventions**: keep `src/components/gradia/` + `src/components/ui/`, shadcn style `base-nova`.
- **Freeze the Radix/@base-ui dual stack:** no NEW Base UI components; standardize per-component on whatever each already uses.
- Credits display: existing **human-units** convention wins; the topbar pill shows human units.

### A8 — Nudge engine: deferred post-alpha.
It needs schema + server logic — not this phase. This phase: build the `NudgeCard` component per Language Pack §4 and remove the guardrail-violating Home nudges (A5). The engine — triggers, caps, server-side dismissal persistence, event logging — is a **named item on the backend gap list**.

### A9 — July 10 alpha scope (the cut line). Must land, in order:
1. **L0.5** — data capture (A6), with the capture-failure test.
2. **L1** — retheme: dark purple tokens, A2 font spec, strip cinematic from dashboard. **Rewrite `platform/docs/BUILD_REFERENCE.md` in the same commit** so it describes the new system (doc drift kills us otherwise; keep it `@`-included in `platform/CLAUDE.md`).
3. **L2** — nav consolidation (A4).
4. **L3** — Home + Approvals + Conversations polish **only**.
5. **L4-lite** — call-record page (fed by newly captured data) + Activity feed derived from `pending_actions`/`custom_agent_runs`; "because" lines render **only where the new decision log has data** (never fabricated).

**Post-alpha, explicitly cut:** nudge engine, digest/push (§5.6), AI-disclosure setting (§5.7), density toggle, light mode, Customers/Settings deep polish, remaining Layer 4 items.

### A10 — Branch collision containment.
The in-flight NEXT-3 recovery work (branch `mvp/phase-0-subtraction`) touches files this redesign would restyle. **`recovery-flow.tsx` and `customers-table.tsx` are excluded from restyling this session** — they may be retokened via CSS variables only, no structural edits — so the eventual merge stays sane.

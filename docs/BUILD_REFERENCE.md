# Gradia Build Reference

This file is the source of truth for how Gradia looks, sounds, and behaves.
Read it before building or refactoring any screen. When a request conflicts
with this file, follow this file or ask. Goal: every new screen should look
like it was always part of Gradia.

## 0. What Gradia is
An AI front office for local service businesses (reference customer: an
auto-detailing shop). It catches inbound across every channel — voice, email,
SMS, social DMs — turns each into a structured lead, drafts a response in the
owner's voice, and waits for a human yes before anything leaves the shop.
Personality: "your AI office that works like a trusted co-owner, not a tool."
First person plural ("we caught this," "waiting on us," "what I'd tackle next").
Core object: the **lead** (a person who reached out). A lead becomes a
**customer** once there's a real relationship/booking.

## 1. Non-negotiable design language
**Voice & copy** — First person plural, always ("everyone we're working,"
"waiting on us"). Editorial headline pattern: a roman/serif phrase with ONE
italic word for emphasis. Section eyebrow above each headline (uppercase,
letter-spaced, muted). Subhead: one quiet, warm sentence. Empty states are
written, never blank.

**Type** — Display/headline: serif (editorial, high-contrast) — the brand
signature, used big on every section header, KPI numbers, agent names.
Body/UI: clean sans. The serif + italic-accent combo is the most identifying
visual trait; reuse on every screen.

**Color (dark-first)** — Near-black warm background; subtle card elevation,
hairline borders, ~16px radius, generous padding. ONE accent: warm
coral/orange (primary buttons, active nav, live/setup pill, badge counts).
Never a second accent. Status colors semantic + quiet (COLD gray-blue,
PENDING/PAUSED/NEEDS-INFO amber, NEW coral, LIVE green). Status is always
**icon + text, never color alone**.

**Layout** — Fixed left sidebar (brand lockup, WORKSPACE label, nav; active =
coral left-bar + tint + colored icon). Centered main column, big top headline,
strong vertical rhythm. Persistent top-right SETUP pill (living progress, not a
one-shot wizard). One primary CTA per screen, coral; everything else quiet.
Skeletons on every async load.

## 2. Navigation (current → target)
Current: Dashboard, Ask Gradia, Agents, Approvals, Customers, Leads, Schedule,
Settings. Target (tighten to 5):
- **Home** — Dashboard + living setup checklist
- **Customers** — merge Leads in (a lead is a customer state: NEW → WARM →
  CUSTOMER); heat/status as facets, not separate pages
- **Approvals** — with the coral count badge
- **Agents** — the agent roster
- **Settings → Connections** — the simplified connections screen (§4)

Ask Gradia → persistent top-bar action / ⌘K (a verb, not a place). Schedule
folds into Home/Customers. Refactor rule: nav change WITHOUT redesigning the
screens themselves — same components, fewer destinations.

## 3. The screens
- **Home** — "Today, together at [shop]." Live channel count, revenue KPIs,
  "What I'd tackle next" nudges, "Where we're listening" channel tiles.
- **Ask Gradia** — "What do you want to know?" Streaming BI chat (pgvector RAG).
- **Agents** — "What's running for us." Agent roster cards w/ status + prereqs.
- **Approvals** — "Waiting on us." HITL queue of ApprovalCards.
- **Customers** — "Everyone we've heard from." One file per person, channels
  stitched into one thread.
- **Leads (→ merge)** — "Everyone we're working." Live inbound feed table.
- **Schedule (→ fold)** — "What's on the books." Approved bookings.
- **Settings → Connections** — "The wiring behind the scenes." §4.

## 4. Connections refactor (10 → 4)
Owner's mental model: "Does it answer my calls? Handle my messages? Know my
calendar? Sync my jobs?" Collapse to a Connections page of grouped status tiles:
- **CHANNELS:** Voice · Messages (merge Email + SMS)
- **YOUR BUSINESS:** Calendar · Jobs (CRM/Jobber)
- **▸ Advanced (collapsed):** Knowledge · Developer/MCP · Usage & limits

Hide Payments/IG/FB until their phase. Never show an MCP token by default.

**ConnectionTile — one component, three states:** NOT CONNECTED (one Connect
button) → CONNECTING… (spinner, popup open) → CONNECTED (✓ + identity + Manage).

**OAuth flow (highest-impact UX upgrade):** tap Connect → centered OAuth popup
(not full-page redirect) → consent screen → Allow → callback does
`window.opener.postMessage('connected')` then closes → tile flips to Connected
inline, no reload. ⚠️ Requires the Google OAuth app to be **verified** or Google
shows an "unverified app" scare screen. Voice/SMS use the same tile but the
button opens a "Get a number" sheet instead of a popup.

## 5. The autonomy model (suggest ↔ autonomous) — CORE FEATURE
AI defaults to **suggest** (HITL): drafts → human approves → sends. Users can
graduate an agent to **autonomous** (acts, then logs). This toggle is the
product's trust dial.

**Where it lives:** global default in Settings ("How should Gradia act?" →
Suggest first / Act autonomously; new agents inherit) **+** a per-agent override
on each AgentCard (Mode: Suggest ▾ / Autonomous).

**One component, two modes** — model every AI action as `<AgentAction mode=…>`:
- **SUGGEST → ApprovalCard:** proposed action preview + reason; actions Approve
  & send / Edit / Reject; nothing executes until a human clicks; drives the
  coral Approvals badge.
- **AUTONOMOUS → ActivityEvent:** executes immediately, renders as a done event
  in the timeline ("Texted Mike back — confirmed Sat 3pm. ✓ Sent"); affordances
  flip to Undo / Flag / View; everything logged to the customer timeline.

**Invariants:** autonomy still logs everything; some actions are always HITL
regardless of mode (irreversible / money / calendar-writing — honor a per-action
floor); switching mode is an auditable event; prerequisites must be satisfied
before an agent can go autonomous.

## 6. Component inventory (build/extend, don't reinvent)
Sidebar + NavItem · SetupProgressPill · SectionHeader (eyebrow + serif italic
headline + subhead) · KpiCard · LeadsTable / CustomerRow · HeatBadge ·
StatusBadge · ChannelTile + ConnectionTile (3-state) · AgentCard (w/ mode
control) · ApprovalCard (suggest render of AgentAction) · ActivityEvent
(autonomous render) · NudgeCard · ChatThread / AssistantMessage + Composer ·
VoiceCapture + RawNoteCapture · EmptyState (always written).
Use shadcn/ui primitives underneath, but the look above wins — wrap and theme
shadcn to match the serif/coral/dark system.

## 7. How to work on this codebase
Stack: Next.js (App Router) + Tailwind + shadcn/ui. Before a screen: pick its
eyebrow + italic-accent headline, write its EmptyState, build with existing
components. Before an AI action: implement as `<AgentAction mode=…>` so it works
in both renders. Keep advanced surface (MCP/dev, usage, raw config) behind
progressive disclosure. Match we/us voice in every string (check persona.ts).
Don't introduce a second accent color, a second display font, or unwritten empty
states — those are the fastest ways to stop looking like Gradia.

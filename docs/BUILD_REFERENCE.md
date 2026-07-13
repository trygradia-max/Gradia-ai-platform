# Gradia Build Reference

This file is the source of truth for how Gradia looks, sounds, and behaves.
Read it before building or refactoring any screen. When a request conflicts
with this file, follow this file or ask. Goal: every new screen should look
like it was always part of Gradia.

> **Rewritten 2026-07-02 for the glass-box redesign.** The previous
> serif/coral/cinematic system is retired. Full spec + decided amendments:
> `_docs/redesign/GRADIA-REDESIGN-SPEC.md` (§8 amendments win),
> `_docs/redesign/GRADIA-LANGUAGE-PACK.md`,
> `_docs/redesign/COMPONENT-SOURCING-MAP.md`.

## 0. What Gradia is
An AI front office for local service businesses (reference customer: an
auto-detailing shop). It catches inbound across every channel, turns each
into a structured lead, drafts a response in the owner's voice, and waits
for a human yes before anything leaves the shop. Gradia is a **trust
product** — the UI reads as a reliable instrument panel, not a toy.
Core object: the **lead** (a person who reached out). A lead becomes a
**customer** once there's a real relationship/booking.

## 1. Non-negotiable design language

**Voice & copy — narrator vs character (spec §8-A3).** UI chrome is the
NARRATOR: third person, plain, specific, brief — "your receptionist" /
"Gradia", never "the AI" (Language Pack §1). Numbers over adjectives
("Handled 12 calls", never "Great day!"). No exclamation marks except
first-ever success moments; no emoji. Anything the agent itself authored
(chat bubbles, outbound previews, transcripts) is the CHARACTER and keeps
its eval-locked we/us voice from `persona.ts` — untouchable. Chrome
strings live in `src/lib/strings.ts` — no hardcoded UI copy in components.
Empty states are written, never blank: first-use teaches, no-results
offers Clear filters, all-done reassures.

**Type — one family (spec §8-A2).** Geist for everything: 400 body,
500 labels/emphasis, 600 headings — nothing bolder, hierarchy via weight
and text color, never size jumps or a second typeface. **Geist Mono +
`tabular-nums` (the `.font-data` utility) for every number that matters:**
KPI values, money, credits, durations, phone numbers. Closed fixed scale
in the app: 12/13/14 (body)/16/20/24 — `clamp()` and hero sizes are
public-pages-only. Eyebrow labels: `.label-eyebrow` (11px uppercase,
letter-spaced). Instrument Serif is retired — do not re-add it or
introduce any new font.

**Color — dark ships, calm neutral + ONE accent (spec §8-A1).** Near-black
neutral canvas (`--bg-canvas`), hairline borders + soft shadows for
elevation — never colored fills. The silver scale carries borders and
secondary/tertiary text; white is primary text. **The one accent is purple
`--accent: #7C3AED`** (Tailwind `primary`): primary buttons, links, focus
rings, active nav — nothing else, ONE accent-colored primary action per
screen. Accent-colored *text* on the dark canvas uses `--accent-text`
(AA-safe). Semantic status tokens (`--status-success/warning/danger/info`
+ `-fg`/`-bg` companions) appear ONLY on status — success = handled/
booked, warning = needs review/low confidence, danger = escalated/failed,
info = AI-in-progress. Status is always **icon + text, never color
alone**. No component references a raw hex — semantic tokens only
(documented exceptions: the Google logo SVG, the standalone OAuth popup
document). Light theme tokens exist (`.light`) but do not ship.

**Shape & motion.** Radii closed set: 6px inputs/buttons (`rounded-sm`),
10px cards (`rounded-md`), 16px modals (`rounded-lg`); full-round for
avatars/pills only. Motion: 100–150ms ease-out for ALL functional
feedback (hover, open, toast); 250–400ms only for onboarding/celebration.
Respect `prefers-reduced-motion`. **The cinematic layer — grain, mesh,
glass cards, accent glow, long staggered reveals — is public-pages-only**
(`/`, `/how-it-works`, `/login`, `/onboarding`). Dashboard surfaces stay
calm: skeletons on every async load, never spinners for page loads.

## 2. Navigation (final IA — spec §8-A4)
Sidebar exactly: **Home · Approvals (badge = pending count) · Activity ·
Conversations · Customers · Receptionist** — pinned bottom: **Numbers &
Billing · Settings**. Consolidations: agent/agents/agents-build →
Receptionist; chat (Ask Gradia) → Conversations; leads + recovery →
Customers; schedule's home is decided in the Layer 2 plan. Activity's
"Needs review" filter deep-links to Approvals — never duplicates it.
The **⌘K/Whisper command bar is the primary composer** (desktop ⌘K,
mobile bottom composer with tap-to-talk) — retoken it, never demote it;
it is still never the only path to any action. Topbar usage pill shows
**human units** ("~200 texts · ~20 calls"), credits in fine print.

## 3. The screens
- **Home** — ROI receipt pinned on top (sacred: conservative, traceable,
  written zero-state) → KPI sparkline row (*Calls handled today · Leads
  captured · Appointments booked · Needs your review* → links to
  Approvals) → recent Activity module. No nudge cards on Home (§8-A5/A8).
- **Approvals** — "Waiting on you." The one HITL inbox: Approve /
  Edit & approve / Dismiss — never binary approve/reject.
- **Activity** — the glass box: reverse-chronological agent feed; routine
  wins log quietly, exceptions surface loudly. Each entry: what happened,
  outcome badge, AI/human flag, and the "because" line **rendered only
  where the decision log has data — never fabricated**.
- **Conversations** — calls + SMS unified; rows show caller, time,
  one-line summary, outcome badge, AI/human flag.
- **Customers** — one file per person, channels stitched into one thread;
  recovery is a flow inside customer context.
- **Receptionist** — progressive disclosure: the 5 things every owner
  sets up front, everything else behind Advanced.

## 4. Connections
Owner's mental model: "Does it answer my calls? Handle my messages? Know
my calendar? Sync my jobs?" Grouped status tiles; **ConnectionTile — one
component, three states:** NOT CONNECTED (one Connect button) →
CONNECTING… → CONNECTED (✓ + identity + Manage). OAuth in centered popups,
not full-page redirects. No vendor names, env vars, or raw enums anywhere
an owner can see (UX spec rename map).

## 5. The autonomy model (suggest ↔ autonomous) — CORE FEATURE
AI defaults to **suggest** (HITL): drafts → human approves → sends. Owners
can graduate an agent to **autonomous** (acts, then logs). Model every AI
action as `<AgentAction mode=…>`: SUGGEST → ApprovalCard (nothing executes
until a human clicks; drives the Approvals badge); AUTONOMOUS →
ActivityEvent (executes, logs to the feed with Undo / Flag / View).
**Invariants:** autonomy still logs everything; money + calendar writes
are ALWAYS HITL regardless of mode (`ALWAYS_HITL` floor — never bypassed);
switching mode is auditable; confidence is qualitative, never a
percentage ("Review this" / "Needs you" — Language Pack §3).

## 6. Component inventory (build/extend, don't reinvent)
Sidebar + NavItem · SetupProgressPill · SectionHeader (eyebrow + Geist-600
headline + subhead) · KpiCard (`.font-data` numbers) · data tables w/
density toggle · HeatBadge · StatusPill (semantic tokens only) ·
ChannelTile + ConnectionTile (3-state) · AgentCard (w/ mode control) ·
ApprovalCard · ActivityEvent · NudgeCard (Language Pack §4 — engine is
post-alpha) · ChatThread / Composer · VoiceCapture · EmptyState (always
written) · call-record components (`components/glassbox/`, Layer 4).
shadcn/ui primitives underneath (style `base-nova`, existing paths
`components/ui/` + `components/gradia/`); imports are retokened before
commit and only at the layer that uses them (sourcing map rule). Recharts/
Tremor copy-paste for charts (Layer 3). No new Base UI components — the
Radix/Base UI mix is frozen.

## 7. How to work on this codebase
Stack: Next.js (App Router) + Tailwind v4 (CSS-first, tokens in
`src/app/globals.css`) + shadcn/ui. Before a screen: pick its eyebrow +
headline, write its EmptyState in `strings.ts`, build with existing
components. Before an AI action: implement as `<AgentAction mode=…>`.
Keep advanced surfaces (MCP/dev, raw config) behind progressive
disclosure. The fastest ways to stop looking like Gradia: a second accent
color, a second typeface, an unwritten empty state, a percentage
confidence score, or cinematic motion on a dashboard surface — don't.

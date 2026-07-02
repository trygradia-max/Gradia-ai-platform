# Gradia UI/UX Redesign Spec

**Direction:** calm neutral base + one accent. Gradia is a trust product — an AI answering a shop's customers. The UI must read as a reliable instrument panel, not a toy.

**Research basis:** monday.com's open-source Vibe design system (token values read from their repo, not guessed), Linear/Stripe/Attio pattern analysis, Intercom Fin + Smith.ai + Goodcall for glass-box agent UX, Microsoft HAX guidelines and NN/g. Sources cited inline. Third-party teardown values are marked as such.

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

### 2.1 Neutrals (the app is ~95% these)

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
| `--accent` | **pull the exact purple from the marketing repo's design system** (commit `66de43b` era); fallback `#7C3AED` only if none is defined there | Primary buttons, links, focus rings, active nav — nothing else |
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

### 2.4 Typography

- Font: **Inter** (variable) with system-ui fallback. One family; hierarchy via weight and color, not size jumps (Stripe/Linear pattern).
- Scale (6 sizes, that's all): 12 / 13 / 14 (body default) / 16 / 20 / 24. Line heights 16 / 18 / 20 / 22 / 28 / 32.
- Weights: 400 body, 500 emphasized/labels, 600 headings. Nothing bolder than 600.
- Numbers in metrics/tables: `font-variant-numeric: tabular-nums`.

### 2.5 Spacing, radius, motion

- Spacing: closed set only — 4, 8, 12, 16, 24, 32, 48, 64. No arbitrary values.
- Radius: `--radius-sm: 6px` (inputs, buttons), `--radius-md: 10px` (cards), `--radius-lg: 16px` (modals). Full-round for avatars/pills only.
- Motion: 100–150ms ease-out for all functional feedback (hover, open, toast); 250–400ms only for onboarding/celebration moments. Respect `prefers-reduced-motion`.
- Dark mode: define tokens now even if you ship light-only; flipping is then a token file change, not a refactor.

## 3. App shell & navigation

- **Fixed left sidebar**, `--bg-sunken`, collapsible. Workspace/shop switcher top-left (universal SaaS convention — Notion, Linear, Attio).
- A shop owner has ~5 daily destinations. Sidebar is exactly:
  1. **Home** (dashboard)
  2. **Activity** (glass box — the agent feed)
  3. **Conversations** (calls + SMS/chat, unified)
  4. **Customers**
  5. **Receptionist** (agent builder/settings)
  — then pinned at bottom: **Numbers & Billing**, **Settings**. Everything else lives inside those. If the current app has 10+ nav items, that's the flow problem: collapse them.
- Top bar: page title, search, credits/usage pill (links to billing), help. No secondary nav rows.
- Cmd+K command palette: nice-to-have layer for power users, never the only path to any action (owners are non-technical).

## 4. Screen-level UX rules

**Dashboard (Home)** answers "is everything OK?" in one glance (Stripe pattern): 3–4 headline numbers with sparklines — *Calls handled today · Leads captured · Appointments booked · Needs your review* — then the most recent Activity entries. Not a wall of charts.

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
Filters: Needs review / Handled / Escalated / All. "Needs review" count badges in the sidebar.

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

No mobile app work, no marketing site, no new agent capabilities — presentation and transparency of what exists. No localization pass. Dark mode: tokens defined, shipping deferred.

## 7. Key sources

Vibe tokens: github.com/mondaycom/vibe (`colors.json`, `spacing.scss`, `typography.scss`, `motion.scss`) · Linear: linear.app/now/how-we-redesigned-the-linear-ui · Stripe UX analyses (third-party) · Attio teardowns (third-party — values marked observed) · Intercom Fin: intercom.com/help articles 7120684, 9929230, 11712008 · Smith.ai call intelligence docs · Goodcall.com · NN/g: empty states, progressive disclosure, AI hallucinations · Microsoft HAX Toolkit (18 guidelines) · Shape of AI (Footprints, Citations) · Smashing Magazine agentic-AI + AI-transparency patterns (2026) · HatchWorks agent UX patterns · Monday onboarding teardown (Ojasild) · Cloudwards Monday review.

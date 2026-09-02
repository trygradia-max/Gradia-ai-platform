# UI — Reference Board

_Created 2026-07-25 by the Organizer. Records the approved visual references and the adopt/reject decisions that came with them, per `platform/HOME_REDESIGN_PLAN.md` §Design direction (2026-07-16) and `platform/docs/BUILD_REFERENCE.md`. References inform; the token system decides._

## Why a reference board

References are how new surfaces get direction without smuggling in violations of our own system. Every approved reference carries an explicit **adopt** list and a **reject** list. A reference without both lists is not approved.

## Approved references

### 1. Dashdark-X-style dark analytics dashboards
_Approved 2026-07-16 with the Home rebuild (HOME_REDESIGN_PLAN §Design direction)._

**Adopt:**
- Instrument-panel density: stat tiles with delta chips (signed, vs a named period, icon + text, status tokens).
- A real revenue chart as the analytics centerpiece.
- Tighter section rhythm — eyebrow + 15px heading instead of oversized editorial headlines.
- Compact table/list rows.

**Reject:**
- Multi-hue chart series (blue/pink/green). We have ONE accent. The chart palette is: collected in purple `#8B5CF6`, booked-ahead as a dashed de-emphasis silver `#A1A1AA` line — validated for CVD + contrast on our surface.
- Glassmorphism / neumorphism / glow — the cinematic layer is public-pages-only.
- Percentage deltas fabricated from thin data — a delta renders only when the prior period has real rows.

### 2. `gradia-home-mockup.html` (repo root)
The approved Home direction mockup — sample data only. Referenced by `home-analytics.tsx` comments. Treat as a **direction artifact**, not a spec: the HOME_REDESIGN_PLAN text wins where they differ. After the home-redesign branch merges and BUILD_REFERENCE §3 is reconciled (source-map contradiction C-08), this file is an archival candidate.

### 3. Founder reference systems (master definition, 2026-07-27)

Six reference systems recorded from the founder master product definition. Per the board's own rule, each carries an adopt list; the shared reject list follows. None is a pixel-for-pixel source (founder rule: "Do not copy any product pixel-for-pixel"); the token system still decides.

| Reference | Adopt (borrow lists, founder-stated) |
|---|---|
| **Linear** | Hierarchy; navigation discipline; spacing; product density; fast interactions. |
| **Attio** | CRM record presentation; data-rich but calm interfaces; agent and workflow *activity* presentation. |
| **Stripe** | Trust; editorial clarity; explanation of complex systems; typography hierarchy. |
| **Jobber** | Direct service-business terminology; clear job lifecycle; approachable workflows. |
| **Vapi** | Interactive voice demonstrations; transcript and outcome visualization. |
| **Urable / OrbisX** | **Terminology and operational feature expectations ONLY** — industry vocabulary, workflow coverage checklists. Explicitly NOT a visual design standard. |

**Reject (founder avoid-list — applies to all six and to any future reference):** carbon-fiber textures · checkered flags · generic sports-car imagery · excessive glassmorphism · neon AI effects · floating glowing objects · constant animation · fake dashboards · fake metrics · dead controls · overly dense enterprise navigation.

## Standing rejections (apply to any future reference)

- Any second accent or multi-hue data series.
- Serif or display typefaces (Instrument Serif retired).
- Confidence percentages, gauges, or scores presented as precision.
- Fake-data preview states — previews use written empty states or real seeded data (D-025).
- Cinematic motion (grain, mesh, glass, long staggered reveals) on dashboard surfaces.

## Adding a reference

1. Organizer records it here with source, date, and the surface it informs.
2. Write the adopt/reject lists BEFORE any build uses it.
3. If adoption would require a token or type-scale change, that is a design-system amendment — it goes through the decision queue, not this board.

## Stripe Dashboard — founder-designated reference for UX-001 (2026-09-01)

_Source: founder screenshots of dashboard.stripe.com (Home, Customers empty state, Reports index, Payments analytics), saved in `ui/references/stripe-*.png`. Surface informed: every dashboard route in UX-001; the pattern list is the acceptance checklist. Founder's words: "same kind of layout and look, obviously with Gradia branding, tools and capabilities — super easy and clean." Not the wording, not the components, not the colors._

### ADOPT (concrete patterns, mapped to Gradia)

1. **Page = title + one-line purpose + sections with a heading and a one-sentence explanation.** Stripe's Reports page: "Track money movement — Understand the activity in your account…" then cards. Gradia: every route gets an H1, and every section a heading + one plain sentence saying what it does. Narrator voice from `copy-guidelines.md`.
2. **Dismissable "lightbulb" tip bar under the title** — one sentence + one link + ✕. Gradia: one tip per route, shop-dismissable, fed from a small `tips.ts` map keyed by route; never more than one visible. This is the "tips around each feature" the founder asked for.
3. **ⓘ tooltip next to every metric and card title** ("Gross volume ⓘ"). Gradia: every KPI on Home, every Approvals card type, every Settings card, every Receptionist builder field gets an ⓘ with ≤ 2 sentences. Use the existing tooltip primitive.
4. **Designed empty states, centered, with icon + headline + one sentence + primary action** (Stripe Customers: "Add your first customer — Bill customers… [Learn more] [+ Add customer]"). Gradia: every list/table route (Customers, Conversations, Approvals, Activity, Calendar) uses this exact shape when empty; dashed-border containers for empty chart/metric areas ("No data"). Ties to `state-matrix.md`.
5. **Filter chip row above lists** (All · Top customers · First-time · …). Gradia Customers: All · Needs follow-up · Quoted, not booked · Lapsed · Fleet; Conversations: All · Needs reply · Calls · Texts · Email.
6. **Search at the top of the page, keyboard-first** — Stripe's global search + "N" shortcut on primary action. Gradia already has ⌘K/Whisper as the primary composer (locked); make sure the visible search field on Customers/Conversations is present and fast, and the primary action button shows its shortcut key.
7. **Calm sidebar: short flat list, grouped by a small uppercase label, one active state, no icons competing with text.** Gradia keeps the shipped seven destinations; the grouped-label pattern is how the 9-item IA lands later (Q-23a) without clutter.
8. **"Updated 4 seconds ago · More details" footer on every metric card.** Gradia Home analytics cards get a freshness line and a "More details" link — cheap trust.
9. **Compare-to-previous-period controls on analytics** (Date range · Daily · Compare). Gradia Home: last 7 days / previous period only; no new chart types.
10. **Lots of white space, hairline borders, one accent used for links/active state only.** Already the design-system rule; UX-001 enforces it where the current UI is denser than this.

### DO NOT COPY

- Stripe's product-family sidebar depth (Treasury / Payments / Billing sub-trees) — that is enterprise nav; Gradia stays at seven destinations.
- Stripe's purple as Gradia's accent hue — Gradia keeps its own violet token; no hue changes.
- Any Stripe wording, icons, or component code. Patterns only.
- Metric-heavy Home. Gradia Home leads with "what needs attention" (approvals, today's jobs, open quotes), and the ROI receipt — not a wall of $0.00 cards.
- Bottom developer bar / "Developers" mode.

### Acceptance for UX-001 against this board

Each dashboard route is checked against items 1–10 on the Vercel Preview by the founder. A route passes when: title + purpose line present · ≤ 1 tip bar · ⓘ on every metric/card title · empty state in the four-part shape · filter chips where a list exists · no stale copy · no "Connect" shown for a connected integration.

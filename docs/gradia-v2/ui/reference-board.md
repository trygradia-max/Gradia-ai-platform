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

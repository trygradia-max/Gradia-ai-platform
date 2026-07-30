# UI — Design Tokens

_Created 2026-07-25 by the Organizer. Condenses the token rules from `platform/docs/BUILD_REFERENCE.md` §1 and `_docs/redesign/GRADIA-REDESIGN-SPEC.md` (§8-A1/A2 amendments win). Token **values** live in code — `src/app/globals.css` (Tailwind v4, CSS-first) — which is the source of truth for exact values; this file records the categories and the hard rules._

## Where tokens live

- `src/app/globals.css` — all token definitions (Tailwind v4 CSS-first config; no `tailwind.config.js`).
- Components consume **semantic tokens only**. No component references a raw hex. Documented exceptions: the Google logo SVG and the standalone OAuth popup document.
- A **light theme token set exists (`.light`) but does not ship.** Do not build against it or expand it without a decision.

## Token categories

| Category | Tokens (representative) | Rules |
|---|---|---|
| Canvas & surfaces | `--bg-canvas`, surface/elevation tokens | Near-black neutral. Elevation = hairline borders + soft shadows, never colored fills. |
| Text | white primary; silver scale for secondary/tertiary | Hierarchy via weight + text color, not size jumps. |
| Accent | `--accent: #7C3AED` (Tailwind `primary`), `--accent-text` (AA-safe on dark) | Primary buttons, links, focus rings, active nav — nothing else. One accent-colored primary action per screen. |
| Status | `--status-success/warning/danger/info` + `-fg`/`-bg` companions | ONLY on status. Always icon + text, never color alone. Raw amber/red/green utility classes are violations (audit doc 08 flagged raw `text-amber-600` in settings cards — cleanup rides P0-010). |
| Type | Geist 400/500/600; Geist Mono via `.font-data` (+ `tabular-nums`) | Closed app scale: 12/13/14 (body)/16/20/24. `clamp()` and hero sizes are public-pages-only. `.label-eyebrow` = 11px uppercase, letter-spaced. No new fonts, ever. |
| Shape | radii: 6px inputs/buttons (`rounded-sm`), 10px cards (`rounded-md`), 16px modals (`rounded-lg`) | Full-round for avatars/pills only. Closed set — no new radii. |
| Motion | 100–150ms ease-out functional; 250–400ms onboarding/celebration only | Respect `prefers-reduced-motion`. Cinematic layer public-pages-only. |
| Chart | collected series purple `#8B5CF6`; projection/de-emphasis silver `#A1A1AA` dashed | One-accent rule extends to charts: emphasis carried by the single purple, never multiple hues (HOME_REDESIGN_PLAN). |

## Hard rules (reviewer checklist)

1. No raw hex in components (grep the diff).
2. No new font family or weight above 600.
3. No new accent; no accent used for non-primary decoration.
4. Status tokens never used for emphasis or branding.
5. No new radii, no arbitrary type sizes inside the app shell.
6. Public-page cinematic tokens (grain/mesh/glass/glow) never imported into `(dashboard)` surfaces.
7. Token additions or value changes are design-system amendments → decision queue + BUILD_REFERENCE update, never a silent commit.

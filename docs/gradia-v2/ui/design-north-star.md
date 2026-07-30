# UI — Design North Star

_Created 2026-07-25 by the Organizer. Condenses `platform/docs/BUILD_REFERENCE.md` §0–§1 and `_docs/redesign/GRADIA-REDESIGN-SPEC.md` (§8 amendments win). Those documents are binding; this is the planning-grade summary._

## What Gradia is, visually

Gradia is a **trust product**. The UI reads as a **reliable instrument panel**, not a toy, not a marketing surface, not a chatbot skin. An owner glances at it between jobs, with dirty hands, on a phone, and must instantly know: what happened, what needs them, what the money looks like.

The identity in one line: **calm dark instrument panel, one purple accent, real numbers in mono, and a human yes before anything leaves the shop.**

## The pillars

1. **Dark, calm, neutral.** Near-black canvas (`--bg-canvas`), hairline borders and soft shadows for elevation — never colored fills. The silver scale carries borders and secondary/tertiary text; white is primary text.
2. **One accent.** Purple `--accent: #7C3AED` for primary buttons, links, focus rings, active nav — nothing else. ONE accent-colored primary action per screen. A second accent color is the fastest way to stop looking like Gradia.
3. **One typeface.** Geist everywhere: 400 body, 500 labels/emphasis, 600 headings. Hierarchy via weight and text color, never size jumps or a second family. **Geist Mono + `tabular-nums` (`.font-data`) for every number that matters** — KPI values, money, credits, durations, phone numbers.
4. **Status is icon + text, never color alone.** Semantic status tokens (`--status-success/warning/danger/info`) appear ONLY on status: success = handled/booked, warning = needs review, danger = escalated/failed, info = AI-in-progress.
5. **Numbers over adjectives.** "Handled 12 calls," never "Great day!" Every figure traces to a real row; deltas render only when the prior period has real rows (the ROI-receipt discipline, transferred to the Home analytics header by the 2026-07-16 amendment).
6. **The glass box.** AI work is visible and explainable: routine wins log quietly, exceptions surface loudly, "because" lines render only where the decision log has data — never fabricated. Confidence is qualitative, never a percentage.
7. **Calm dashboard, cinematic public pages.** Grain, mesh, glass, glow, and long staggered reveals live on `/`, `/how-it-works`, `/login`, `/onboarding` ONLY. Dashboard motion is 100–150ms ease-out functional feedback; skeletons on every async load, never spinners for page loads.

## The identity tests (run on any new screen)

- Could an owner tell what needs them in under three seconds?
- Is every consequential number in `.font-data` and traceable to a row?
- Is there exactly one accent-colored primary action?
- Is every empty state written (first-use teaches, no-results offers Clear filters, all-done reassures)?
- Does anything the agent authored keep its eval-locked we/us voice, untouched by chrome copy?

## The five fastest ways to stop looking like Gradia

Per BUILD_REFERENCE §7 — a builder who does any of these has broken the system:

1. A second accent color.
2. A second typeface (Instrument Serif is retired — do not re-add any font).
3. An unwritten empty state.
4. A percentage confidence score.
5. Cinematic motion on a dashboard surface.

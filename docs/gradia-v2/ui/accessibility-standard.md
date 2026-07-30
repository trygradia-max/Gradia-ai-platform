# UI — Accessibility Standard

_Created 2026-07-25 by the Organizer. The accessibility bar for every user-facing change, drawn from `platform/docs/BUILD_REFERENCE.md` (AA-safe accent text, icon+text status, reduced motion) and standard WCAG 2.1 AA practice. Part of `../12-definition-of-done.md`._

## Contrast & color

- Text meets **WCAG AA** on the dark canvas. Accent-colored *text* uses `--accent-text` (the AA-safe variant), never raw `--accent`.
- **Status is never color alone** — always icon + text. This is simultaneously a design rule and the color-blindness guarantee.
- Chart palette (purple emphasis + silver dashed de-emphasis) was validated for CVD + contrast on our surface (HOME_REDESIGN_PLAN); keep any new series inside that validation or re-validate.
- The silver scale's tertiary text is for genuinely tertiary content — never for body copy or control labels.

## Focus & keyboard

- Visible focus rings (accent token) on every interactive element; never `outline: none` without a replacement.
- Full keyboard paths: sidebar navigation, ⌘K command bar (the flagship keyboard affordance), approval decisions, dialogs (focus trap, Escape closes, focus returns to invoker).
- shadcn/Radix primitives carry most of this — retokening must not strip their focus/ARIA behavior (sourcing-map rule: retoken at the use layer, don't fork internals).

## Semantics & screen readers

- Landmarks: one `main` per page, nav labeled, headings hierarchical (the eyebrow+headline pattern maps to real heading elements, not styled divs).
- Every form control has a label; errors are programmatically associated (`aria-describedby`) and announced.
- Icon-only buttons carry `aria-label` in narrator voice ("Approve draft to Marcus", not "check icon").
- Live regions for async outcomes owners must not miss: approval results, send failures, credit-cap warnings.
- Numbers formatted for meaning: `.font-data` is visual; screen-reader output must still read as money/duration/phone, not digit soup where formatting helps.

## Motion & vestibular safety

- `prefers-reduced-motion` respected on every animation, including the public-page cinematic layer.
- No motion conveys sole meaning — anything animated has a static equivalent state.

## Voice & audio surfaces

- VoiceCapture/Whisper: recording state must be visible (not audio-only), stoppable by keyboard and touch, with a text alternative path (type instead of speak) — consistent with "⌘K is never the only path to any action."
- Call transcripts render as readable text (they already land in `interactions`/glass-box records); audio is never the only record.

## Review checklist per diff

- [ ] AA contrast for new text/controls (spot-check with tooling).
- [ ] Icon+text on any new status; no color-only signal.
- [ ] Keyboard path exercised end-to-end; focus visible and returned.
- [ ] Labels/aria on new controls; errors announced.
- [ ] Reduced-motion behavior verified for new animation.
- [ ] Touch targets ≥ 44px (with `responsive-rules.md`).

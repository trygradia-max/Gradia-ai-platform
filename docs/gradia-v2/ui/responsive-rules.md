# UI — Responsive Rules

_Created 2026-07-25 by the Organizer. Mobile-first rules per `platform/docs/BUILD_REFERENCE.md` and the PWA direction set by decision D-020 (responsive PWA precedes native mobile), delivered in epic E08._

## The mobile reality

Detailers are on their phones, on the job, often with one hand. The founding mobile bar (from the GO_LIVE_CHECKLIST NOW-4 smoke) still stands: **on a phone — capture a lead by voice → approve a staged text → read the receipt, all in under 60 seconds, with no vendor/tech strings visible.** Any surface that breaks that loop on mobile is not done.

## Layout rules

- Mobile-first composition; desktop is the enhancement.
- Grids collapse predictably (e.g. the Home analytics 2-col grid collapse verified in the Home rebuild Phase 5 checklist).
- Tables collapse to cards on narrow viewports; the density toggle is a desktop affordance.
- No horizontal scroll on any owner surface; wide content (transcripts, tables) scrolls within its own container.
- Touch targets ≥ 44px; primary actions reachable in the thumb zone.

## The mobile composer

- Desktop: ⌘K command bar. Mobile: **bottom composer with tap-to-talk** — the same primary-composer status, never demoted (BUILD_REFERENCE §2).
- Whisper (voice capture) is a first-class mobile input: speak → staged actions; the flow must work glove-adjacent (big targets, obvious record state).

## PWA direction (D-020 → E08)

Target scope at E08 (planning-level; final spec in the E08 epic):

1. Installable: manifest, icons, standalone display.
2. Reliable shell: app shell + skeletons load on poor connections; written offline state (read-only where feasible — Approvals/Activity read views first).
3. Push-notification decision (approvals badge parity on mobile) — decision-queue item; not assumed.
4. No native apps before the PWA is complete (D-020). No React Native/Swift work is scheduled anywhere in P0–P10.

Current state honestly: the app is responsive server-rendered Next.js; there is **no manifest/service worker today** — "PWA" is a planned capability (capability 27 in `../04-capability-map.md`), not a current claim (D-028).

## Review checklist per surface

- [ ] Verified at 375px, 768px, and desktop widths.
- [ ] Primary action visible without scroll on mobile where the flow demands it (approve, send, save).
- [ ] Table→card collapse or in-container scroll — no page-level horizontal scroll.
- [ ] Composer/tap-to-talk unobstructed by keyboards or safe-area insets.
- [ ] Motion identical rules on mobile; reduced-motion respected.

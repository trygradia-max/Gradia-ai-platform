# Cursor: Gradia copy and motion

Founder request, October 20, 2026. Local brief:
`/Users/harryhatch/Gradia/CURSOR_UI_COPY_AND_MOTION_2026-10-20.md`.
Work through the site and app in **separate PRs**. Start with onboarding,
friendly copy, and the welcome transition.

Read AGENTS.md and the September 11 governing documents. Preserve MVP
scope, approval-first behavior, and honest channel status. Do not claim a
live channel, a send, or “everything is connected.”

## Voice

Warm without exaggerating. Numbers over adjectives. “Agentic operating
system” is positioning — not something to repeat in the interface.

Exact picks for this pass:

| Surface | Copy |
| --- | --- |
| Onboarding | “What would you like help with first?” |
| Dashboard | “3 replies need your review.” (real count; pluralize) |
| Empty inbox | “Your customer conversations will appear here.” |
| After setup | “Welcome to Gradia, [business name].” |

## Motion and welcome

Dark charcoal, soft silver/violet particles, a short welcome, then a
gentle transition into the app. No forced wait, fake progress, or
“everything is connected” claim. Respect `prefers-reduced-motion`.

Cinematic motion stays on public/onboarding surfaces
(`/login`, `/onboarding`, the post-setup welcome). Dashboard chrome stays
calm: 100–150ms feedback.

## References (fit, not a ranking)

| Resource | Use |
| --- | --- |
| shadcn/ui | Main component foundation |
| Supabase Design System | Forms, layouts, empty states |
| Mercury | Brand restraint and welcoming presentation |
| Motion | Smooth transitions and reduced-motion support |
| Base UI | Accessible interactive controls |
| Radix | Dialogs, menus, and focus behavior |
| 21st.dev | Selected component and section ideas |
| Mobbin | Real product screens and flows |
| Page Flows | Onboarding sequence references |
| Magic UI | Carefully chosen animated accents |

Reuse existing `src/components/ui` wrappers. Do not replace the
Radix/Base UI mix or run an installer that overwrites them.

## PR sequence

1. Onboarding copy + skippable welcome transition (this PR).
2. Dashboard review copy.
3. Inbox empty states.
4. Remaining signed-in chrome (settings, approvals, activity, login warmth).
5. Public pages in this repo (`/login`, `/how-it-works`). Marketing lives
   in a separate repository — do not edit it from a platform session.

## Boundaries

Own presentation and its tests. Do not change server actions, RPCs,
migrations, consent/proof, or send behavior to match a motion demo.
Keep Git deployment disabled. No production changes or real provider sends.

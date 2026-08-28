# UI — README

_Created 2026-07-25 by the Organizer. This directory condenses and extends the Gradia design system for planning purposes. The **binding sources remain**: `platform/docs/BUILD_REFERENCE.md`, `_docs/redesign/GRADIA-REDESIGN-SPEC.md` (§8 amendments win), `_docs/redesign/GRADIA-LANGUAGE-PACK.md`, `_docs/redesign/COMPONENT-SOURCING-MAP.md`, and `platform/HOME_REDESIGN_PLAN.md` (2026-07-16 amendment). Where anything here appears to conflict with those, they win — flag the conflict in `../16-document-source-map.md` instead of building from this copy._

## Why this directory exists

The design system is real and enforced in the codebase, but its rules are spread across four redesign documents plus BUILD_REFERENCE. The files here give the Organizer, Builder, and reviewers a planning-grade condensation: one file per concern, checkable against a diff, with the gaps and future-epic surfaces recorded. Nothing here invents new design language.

## File map

| File | Concern |
|---|---|
| `design-north-star.md` | What Gradia looks and feels like; the identity tests |
| `reference-board.md` | Approved visual references + explicit adopt/reject lists |
| `design-tokens.md` | Token categories, where they live, hard rules |
| `navigation-model.md` | The shipped IA (seven destinations + two pinned — C-15/Q-15), consolidations, deep-link rules, future surfaces |
| `interaction-principles.md` | Motion, optimism, skeletons, HITL affordances, friction gradient |
| `copy-guidelines.md` | Narrator vs character voice, chrome copy rules, empty states |
| `state-matrix.md` | Required states per surface type; audit gaps closed at the P0-010 close (2026-08-28) |
| `responsive-rules.md` | Mobile-first behavior, PWA direction (D-020, E08) |
| `accessibility-standard.md` | Contrast, focus, status legibility, keyboard, reduced motion |
| `component-inventory.md` | Existing components, sourcing rules, planned gaps for future epics |

## Flow specifications

Screen-level flow specs live in `flows/` (one file per flow: entry point, objective, required data, exact steps, system decisions, AI involvement, permissions, error/empty/success states, next recommended action, mobile behavior, analytics events):

`onboarding.md` · `crm-import.md` · `calendar-connection.md` · `lead-to-job.md` · `quote-to-deposit.md` · `online-booking.md` · `job-completion.md` · `membership-enrollment.md` · `recurring-job-setup.md` · `fleet-visit.md` · `approval-action.md` · `voice-receptionist-setup.md` · `trial-to-paid.md` · `invoice-and-payment.md` · `reschedule-cancel.md` · `communications-inbox.md` · `team-setup.md` _(last four added 2026-07-27 — founder-parity gaps found in the verification audit)_

Flows for capabilities that do not exist yet (deposits, online booking, memberships, recurring, fleets, invoices/payments, reschedule/waitlist, unified comms inbox, team setup) are **target specifications** tied to their epics (E01, E02, E05, E06, E07) — they are not descriptions of current behavior.

## How builders use this directory

1. Before building a screen: read `design-north-star.md`, `state-matrix.md`, and the relevant flow spec.
2. Before writing copy: `copy-guidelines.md`; all chrome strings go in `src/lib/strings.ts`.
3. Before adding a component: `component-inventory.md` — extend, don't reinvent; check the sourcing rules.
4. On review: the Cursor Reviewer checks the diff against `state-matrix.md` and `accessibility-standard.md` as part of `../12-definition-of-done.md`.

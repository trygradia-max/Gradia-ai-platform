# UI — State Matrix

_Created 2026-07-25 by the Organizer. The required-states checklist for every user-facing surface, per `../12-definition-of-done.md` (UI requirements) and `platform/docs/BUILD_REFERENCE.md`. The audit doc 08 gaps below were closed by P0-010 (done 2026-08-28, PR #27)._

## Required states by surface type

Every cell marked ● is required before a surface ships. "Written" means authored copy in `strings.ts`, per `copy-guidelines.md`.

| State | Page/route | Card/module | Form/dialog | Table/list | Async action (button) |
|---|---|---|---|---|---|
| Loading | ● `loading.tsx` skeleton | ● skeleton | ● disabled + progress affordance | ● skeleton rows | ● pending state, no double-submit |
| Empty (first-use) | ● written | ● written | n/a | ● written | n/a |
| Empty (no results) | ● written + Clear filters | ● | n/a | ● written + Clear filters | n/a |
| Empty (all done) | ● written | ● | n/a | ● | n/a |
| Error | ● `error.tsx` boundary | ● inline, actionable | ● field + form level | ● inline, retry | ● toast/inline with cause |
| Success | ● | ● | ● confirmation with specifics | ● | ● narrator toast |
| Permission-denied | ● honest gate (what & why) | ● | ● | ● | ● disabled with reason — never a dead control |
| Integration-unavailable | ● names the missing connection + Connect path | ● (ConnectionTile pattern) | ● | ● | ● fails closed with explanation |
| Offline/degraded (PWA, E08) | ○ target at E08 | ○ | ○ | ○ | ○ |

Additional invariants:
- **No dead controls.** A disabled control states why (the existing env-gated settings cards that name missing server config are the approved pattern — audit doc 08 calls them "honest, not fake UI").
- **Mobile behavior** and **accessibility** (see `responsive-rules.md`, `accessibility-standard.md`) are states of the same checklist, verified per surface.
- Degradation is **visible, not silent** — the "pre-C1 tolerance" pattern (warn-and-continue on missing schema) must never reach a shipped owner surface without a written degraded state.

## Audit doc 08 gaps — resolved at the P0-010 close (2026-08-28, PR #27)

| Gap | Where | Resolution |
|---|---|---|
| **Zero `error.tsx` / `global-error.tsx` / `not-found.tsx` in `src/app`** — any thrown server-component error rendered Next's default screen | app-wide | **Closed** — root boundaries landed pre-P0-010 (home-redesign era); P0-010 added the `(dashboard)`-level `error.tsx` + `not-found.tsx` pair (Sentry-reported, written copy via `strings.ts`, working recovery) and locked existence + capture with a source-scan test |
| Missing `loading.tsx` | customers routes, `/calendar`, `/receptionist`, `/settings` (present: dashboard, activity, approvals, conversations, calls) | **Closed** — customers + settings had landed pre-P0-010; P0-010 added `/calendar` + `/receptionist` skeletons |
| Raw `text-amber-600` classes instead of `--status-warning` tokens | settings connection cards | **Closed before P0-010** — settings cards were already token-compliant at HEAD (verified at the P0-010 audit; the only remaining amber is the public `how-it-works` page — cosmetic follow-up in `../../program/backlog.md`) |
| Stale catalog copy (Slack-era) overstating/misdescribing flows | `/receptionist` catalog, `data/customers.ts` docstring | **Closed** — catalog rewritten to in-app Approvals/Conversations; docstring matches the code |

## Reviewer usage

The Cursor Reviewer runs this matrix against every diff that touches a user-facing surface: identify the surface type, walk the column, demand evidence (screenshot, storybook-less manual check, or test) for each ● the diff introduces or modifies. A missing state is a review block, not a follow-up ticket.

# UI — Interaction Principles

_Created 2026-07-25 by the Organizer. Condenses motion and interaction rules from `platform/docs/BUILD_REFERENCE.md` §1/§5 and `_docs/redesign/GRADIA-REDESIGN-SPEC.md`; the friction gradient reflects the audited AI architecture (audit doc 07)._

## Motion

- **100–150ms ease-out for ALL functional feedback** — hover, open, toast, expand.
- **250–400ms only for onboarding/celebration** moments (first-ever successes).
- Respect `prefers-reduced-motion` everywhere.
- The cinematic layer (grain, mesh, glass, glow, long staggered reveals) is **public-pages-only** (`/`, `/how-it-works`, `/login`, `/onboarding`). Dashboard surfaces stay calm.

## Loading

- **Skeletons on every async load — never spinners for page loads.** Every route section ships `loading.tsx` (gaps tracked in `state-matrix.md`, fix rides P0-010).
- Data that can be server-rendered is: the app is server-first (server components + actions + `revalidatePath`), no global client store, refresh-based rather than realtime.

## Optimistic patterns

- Approvals slide out optimistically on decision (GO_LIVE_CHECKLIST smoke: "approvals slide out optimistically"); the server remains authoritative — a failed execution rolls the action back to pending and the UI must surface that return, never silently re-insert.
- Owner-data edits (notes, tags) may commit optimistically; anything with a side effect beyond the shop's own reversible data does not.

## The HITL affordances (core product interactions)

- **ApprovalCard is three-way: Approve / Edit & approve / Dismiss — never binary approve/reject.**
- Every AI action is modeled as `<AgentAction mode=…>`: SUGGEST → ApprovalCard (nothing executes until a human clicks; drives the Approvals badge); AUTONOMOUS → ActivityEvent (executes, logs with **Undo / Flag / View**).
- Autonomy switching is auditable; money + calendar writes render as ALWAYS-ask regardless of mode — the UI must never present an autonomy toggle that implies otherwise (`ALWAYS_HITL` floor, D-012/D-021).
- Conflict handling (post P0-003/004, D-015/D-016): automatic paths hard-block — the surface explains why the slot is unavailable; HITL approval cards show a conflict warning with a documented override, never a silent pass.

## The friction gradient

Deliberate, from the audited architecture (audit doc 07 §tool calling):

| Action class | Friction |
|---|---|
| Owner's own reversible CRM data (note, lead, customer detail) | Immediate — no approval, toast confirms, undo where cheap |
| Anything customer-facing (SMS, email, booking proposal) | Staged → ApprovalCard |
| Money + calendar writes, high-ticket actions (D-021) | ALWAYS ask, every mode |

Interactions must make the gradient legible: immediate actions feel instant; staged actions visibly land in Approvals (⚡ staged markers where pre-approval work exists).

## Feedback & failure

- Toasts confirm what happened in narrator voice with specifics ("Draft staged for Marcus"), not "Success!".
- Errors are written, specific, and actionable; no dead-end error states (see `state-matrix.md`).
- Nothing in the UI fakes progress — no simulated timers, no fabricated intermediate states (D-025; audit doc 08 confirms the codebase is currently honest — keep it that way).

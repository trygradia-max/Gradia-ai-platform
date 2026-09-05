# B-19 — Draft/edit delta capture (the learning substrate)

## Ticket ID
B-19

## Epic
E09 — Gradia differentiation

## Status
**proposed, decision-gated on Q-26** (cut 2026-09-04 from the ideas review `../program/idea-review-2026-09-04-future-directions.md`). Not in `platform/CONTEXT.md` §4 — the founder inserts it there at a Monday update or it does not get built. Recommended position: after B-04, before B-17.

## Priority
High-leverage, small. Not launch-blocking. **Time-sensitive in one specific way: the data cannot be backfilled.** Every edit-then-approve that happens before this ships is signal destroyed permanently.

## Objective
Persist what the owner *changed* when they edit an agent proposal before approving it — not merely that they edited it. One column plus one write; no new subsystem, no model training in this ticket.

## User outcome
None directly visible in this ticket. This is the substrate the ideas-repo entry (2026-09-04) calls "learn from verified corrections": the owner corrects the agent once, and the correction becomes durable, inspectable, per-shop evidence instead of a discarded diff.

## Why this is the gap (verified 2026-09-04 against HEAD `e1f09c6`)
- `PendingActionRow` (`src/lib/types/database.ts:573`) carries a single `payload: Record<string, unknown>` and a `resolution` enum.
- `trust.ts` records `approved_unedited | approved_edited | rejected | auto` and windows it 90 days at 15 decisions / 90% unedited to offer autopilot. It knows an owner edited a text; it never knows **what they changed**.
- `markEditRequested` (`approvals.ts:2110`) claims the action into `edit_requested` and explicitly performs **"no DB writes besides the claim."** The subsequent approve overwrites `payload`. The original draft is gone.
- Grep across `src/` and `supabase/migrations/`: no `original_payload`, no `edited_payload`, no diff column, nowhere.
- Consequence: the agent can rewrite the same sentence the owner rewrites every single week, forever, and nothing in the system can notice.

## Exact scope
1. **Migration.** Add `original_payload jsonb NULL` to `pending_actions` (nullable — historical rows stay null and readers must tolerate it, per the house tolerance pattern). No backfill is possible; do not fake one.
2. **Capture.** On the first transition into `edit_requested` (and only the first — a second edit must not clobber the true original), copy the current `payload` into `original_payload`. Write it inside the existing claim transaction in `markEditRequested` so a lost delta cannot cost the claim, and so a retry cannot double-write.
3. **Read helper.** `getDraftEdits(supabase, shopId, { actionType?, sinceDays? })` in `trust.ts` returning `{ actionType, original, final, editedAt }[]`, tenant-scoped by construction. Read-only. No LLM call.
4. **One surface, honest.** Where `action_decisions` already renders the "because" line, add nothing new in this ticket beyond making the pair retrievable. **No** "Gradia learned from your edit" copy until something actually consumes it — Guardrail #3.

## Explicit non-goals
- **No learning, no fine-tuning, no prompt rewriting from the delta.** Per the ideas-repo entry's own constraint: an owner correcting one duration may update an approved shop preference; one edit is not a rule. Consuming this data is a separate, later, decision-gated ticket.
- No change to `resolution`, to `trust.ts`'s autopilot thresholds, or to any autonomy floor.
- No retention change. `original_payload` inherits whatever `pending_actions` retention becomes; if it ever carries customer PII beyond what `payload` already does, that is a finding to raise, not to solve here.
- No UI for browsing edits.

## Tenancy
`original_payload` is written on a row that already carries `shop_id`; the read helper is scoped by construction. This ticket adds no new service-role call site. If it would, it uses `forShop()` (ADR-003) rather than a raw `.from()`.

## Tests
- Edit-then-approve preserves the pre-edit payload; `original_payload` matches the draft byte-for-byte.
- **Two sequential edits keep the FIRST original** — the regression that makes the whole dataset worthless if missed.
- Approve-unedited leaves `original_payload` null (absence is meaningful: it means "no correction," not "unknown").
- Reject after edit still preserves the original.
- A failed capture never fails the claim (best-effort contract, matching `decision-log.ts`).
- Cross-tenant: shop A cannot read shop B's deltas through `getDraftEdits`.

## Definition of done
Migration applied; capture wired at the single claim site; helper exported and tenant-tested; the five test cases above green in the standard gate (unit, integration, tsc, lint, build); one paragraph in the PR stating how many deltas the seed fixture produced. Founder acceptance is reading two real deltas out of the table on a Preview.

## Estimated size
One session. Touches ~4 files: one migration, `approvals.ts`, `trust.ts`, `types/database.ts`, plus tests.

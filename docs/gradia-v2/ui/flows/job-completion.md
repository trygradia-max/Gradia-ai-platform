# Flow — Job Completion

_Created 2026-07-25 by the Organizer. Grounded in the existing job status machine (audit doc 03: `appointments` + validated statuses booked→…→closed, timeline events, before/after photos, 48h close sweep) and job-completion side effects (maintenance schedules armed, review-request recipe)._

**Maturity:** PARTIAL — single-operator completion EXISTS (status machine, photos, close sweep); TARGET adds checklists/assignments (E04) and invoice handoff (E05).
**Phase/Epic:** Live core; E04 / P4 (team), E05 / P5 (invoice).

## Entry point
Today's bookings on Home or `/calendar`; the job's page from a customer file.

## User objective
Close out the day's work so the record, photos, follow-ups, and (target) invoice all happen without evening admin.

## Required data
The appointment/job row; final services performed (may differ from quote); before/after photos (optional); completion notes; (target) checklist state, assignee; (E05) final amounts for invoicing.

## Exact steps
1. Owner opens the job → status advances through the validated machine (in-progress → completed).
2. Photos uploaded (private bucket, signed URLs); notes recorded to the timeline.
3. On completion: maintenance schedule arms from coating/PPF/tint jsonb (exists; consumed by E06 recurring), lifecycle → active.
4. Review request drafted (FTC-neutral recipe, code-locked) → staged for approval.
5. **(TARGET E04)** Checklist must be complete (or explicitly skipped with reason) before completion; assignee recorded.
6. **(TARGET E05)** Completion offers "Create invoice" prefilled from quote/actuals → invoice flow (money = ALWAYS-HITL to send/charge).
7. 48h sweep auto-closes stale completed jobs (exists) — never silently deletes anything.

## System decisions
- Status transitions validated in code; no skipping backward without an explicit action.
- Photos: private storage only, signed URL reads (MIME allow-list is a known gap flagged in audit — E10 hygiene; it was never in P0-010's cut scope and P0-010 closed 2026-08-28 without it).
- Follow-up cooldowns prevent the customer being double-messaged by completion + campaign sweeps.

## AI involvement
Suggest-HITL: review request draft, follow-up draft, Whisper "just finished the Smith job" → staged actions. Autonomous mode may auto-send eligible drafts (never money/calendar).

## Permissions
Owner today. Post-E01: assigned member can advance status + upload photos; completion sign-off per role config; invoice actions owner/admin.

## Error states
- Photo upload failure → retry without losing status change.
- Completion side-effect failure (schedule arm, review draft) → job still completes; failure surfaces in Activity, not silently (reliability standard, P0-012).

## Empty states
- No jobs today: "Nothing scheduled today. Upcoming bookings land here."

## Success state
Job closed with photos + notes on the timeline; review request awaiting approval; (target) invoice created; Home analytics reflect it only from real rows.

## Next recommended action
Approve the review request; (E05) send the invoice; (E06) confirm the armed maintenance follow-up date.

## Mobile behavior
Primary surface IS mobile — status advance, camera-roll photo upload, and Whisper capture from the driveway.

## Analytics events
`First job completed`; (E05) `First payment collected` when the first invoice payment lands.

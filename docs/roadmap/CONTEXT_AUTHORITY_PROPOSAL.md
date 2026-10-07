# Proposed CONTEXT.md reconciliation

Status: applied on the documentation branch only. The founder checkout
`~/Gradia/platform` at `20e153a` was not modified. Its uncommitted `CONTEXT.md`
edit is still there.

The founder checkout `/Users/harryhatch/Gradia/platform` is local `main` at
`20e153a8ac7b55bc682e5a49c6e9486ac51e9ae5`, behind GitHub `main`, with a
pre-existing uncommitted `CONTEXT.md` edit. GitHub `CONTEXT.md` at `247bb50`
still says this file wins over every other plan. That sentence conflicts with
the five September 11 documents merged in PR #46 and left untouched by PR #48.

## What the founder edit contains

The uncommitted edit adds section 1b (D-069, 2026-09-08): v1 is voice, CRM,
pipeline, calendar, quotes, Chief of Staff, and staged email, and it cuts SMS
and Meta. It also adds B-19 (keep the shop’s phone number) and B-20 (tell the
owner an approval is waiting).

September 11 superseded the voice-first release order. SMS, website intake, and
Meta are the controlled pilot. Inbound voice is required for the completed
five-channel MVP and stays off until real-call, forwarding, escalation, consent,
and number-continuity acceptance. B-19’s phone-continuity requirement remains
part of that voice gate. B-20’s owner notification remains an approved
notification obligation, now specified as in-app plus independent transactional
email. The ticket number B-19 is also used for draft-edit capture in other
notes. Assign a new ID before implementing either; do not reuse B-19.

## Proposed replacement for the authority paragraph

When the founder chooses to edit `CONTEXT.md`, replace the “this file wins”
paragraph with:

> Product requirements for the sellable MVP are the five September 11, 2026
> documents: `docs/product/GRADIA_MVP_VISION.md`,
> `docs/roadmap/MVP_IMPLEMENTATION_SEQUENCE.md`,
> `docs/architecture/GRADIA_AGENT_ARCHITECTURE.md`,
> `docs/architecture/AUTONOMY_APPROVAL_MODES.md`, and
> `docs/architecture/GRADIA_MEMORY.md`. This file is a dated status and decision
> diary. Where it conflicts with those five documents, those documents win.
> Ideas that are not approved scope are in `docs/roadmap/POST_MVP_IDEAS.md`.

## Stale statements inside GitHub CONTEXT.md

These are status errors even before the D-069 conflict. Correct them only in a
founder edit of `CONTEXT.md`:

- B-01 data export is merged (PR #37) and section 3 still says export is missing.
- B-03 Chief of Staff is merged (PR #39) and the checkbox is still open. The home
  page is no longer the 14-component stack described in U-01.
- B-16’s services, vehicle-size pricing, and hours half is merged (PR #41). G-05
  still says onboarding is only four fields.
- “No email sending” was corrected in the founder edit. GitHub `CONTEXT.md`
  still says email is read-only. Outbound send exists through Aurinko. In-thread
  inbox reply does not.

## What not to delete

Keep the diary of A2P evidence dated 2026-09-03, the voice-unverified warning,
the conflict-enforcement-off warning, and the adoption notes. Label them as
dated evidence. The 2026-09-03 A2P console check was account “Gradia Demo” and
was not re-verified in this pass.

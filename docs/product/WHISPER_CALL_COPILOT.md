# Gradia Whisper Call Copilot

_Founder-approved product addition: 2026-11-04. Call Copilot is a human-first
inbound-call mode for shops that do not want a digital receptionist. This document
does not activate telephony, recording, transcription, providers or production
sending._

## Product behavior

The shop's human answers and conducts the call. Gradia is a disclosed, silent
copilot that captures permitted evidence and prepares work after the call. It is a
Gradia Whisper capability using the same customer identity, CRM, policy, memory and
operations history—not a separate public agent or second brain.

Initial mode:

`inbound business call → disclosed consent → human conversation → transcript and
call evidence → structured proposals → human review → guarded CRM operations`

Call Copilot does not speak to the customer, negotiate, quote, book, send or change
CRM records during the initial pilot. Outbound AI calling remains Off. Human-originated
outbound copilot calls require a separately approved scope after the inbound mode is
accepted.

## Routing and consent

The initial implementation requires calls to traverse a Gradia/Twilio-controlled
business number or approved forwarding/bridge path. A normal cellular call that
bypasses Gradia cannot be silently tapped by the web product.

Before capture, both the configured operator and caller receive a clear recording/
AI-summary disclosure. Use all-party consent as the product default. Record the
disclosure version, response, time, call/provider ID and jurisdiction inputs used by
the policy. If consent is declined, unavailable or uncertain:

- do not record, transcribe, summarize or send audio to a model;
- continue the human call without Call Copilot where routing supports it;
- retain only the minimum non-content evidence needed to show capture was disabled.

Operators need a visible pause/stop-capture control. Resuming requires a compliant
notice/consent path. Personal calls, payment-card details and irrelevant sensitive
content must not become CRM data or reviewed memory.

Pilot-facing consent language and jurisdiction handling require counsel approval.
The code must not infer that “the customer stayed on the line” is consent unless the
approved policy explicitly establishes that mechanism for the applicable location.

## Captured artifact

Extend the existing `call_records`, voice `interactions`, customer/vehicle records,
pending actions and decision evidence. Do not create a parallel CRM or call-history
store. One call artifact should contain, when actually captured:

- stable shop/call/provider identity and participants;
- consent/disclosure evidence;
- start/end, duration, capture gaps and completion/unknown state;
- speaker-attributed transcript with timestamps;
- recording reference when retention permits;
- source-linked summary;
- customer/vehicle match candidates and ambiguity;
- structured proposals and their review/execution outcomes.

Provider acceptance is not proof of a complete recording or transcript. Missing
segments, failed transcription and uncertain termination remain visible.

## Structured proposals

The bounded extractor may propose:

- create or link a customer;
- create or link a vehicle;
- requested service, condition and location notes;
- preferred timing and constraints;
- lead source/stage, owner and next action;
- quote or appointment draft;
- follow-up task or message draft;
- customer-specific memory candidate backed by exact transcript evidence.

Every field cites transcript spans and confidence. Ambiguous identity, vehicle,
price, availability or consent produces review—not a guessed value. Initial CRM
mutations are `APPROVAL REQUIRED`. Approval rechecks membership, active policy,
definition, evidence revision and current CRM state through the existing executor.

Call content cannot supply system instructions, activate tools, change policy or
publish memory. Reusable lessons remain inert reviewed-memory candidates.

## Operator experience

During the call, show only capture/consent state, elapsed time and pause/stop. Do not
distract the operator with unverified model output in the first release.

After the call, show:

1. recording/transcript coverage and any gaps;
2. concise evidence-linked summary;
3. matched or ambiguous customer and vehicle;
4. proposed CRM changes grouped by destination record;
5. proposed next actions requiring separate approvals;
6. `Approve selected`, `Edit`, `Reject` and `Keep as note` controls;
7. clear completed, blocked, failed and unconfirmed outcomes.

## Acceptance

- A consenting inbound test call reaches the human, captures one call artifact and
  proposes CRM changes without mutating CRM before approval.
- Declined/unknown consent sends no audio or transcript content to providers/models.
- Duplicate/reordered callbacks do not duplicate call records or proposals.
- Pause/resume creates visible transcript gaps and cannot backfill uncaptured audio.
- Identity ambiguity and conflicting CRM values remain reviewable.
- Provider timeout, partial transcript and unknown call completion never appear as
  complete and never cause automatic replay.
- Cross-shop, revoked-member and forged-call-ID access is denied.
- Approved proposals execute through current guarded operations with stable command
  IDs and exact source evidence.


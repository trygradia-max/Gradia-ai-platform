# Call Copilot extraction and approval-first CRM proposals (PR E)

_2026-11-20. Implements PR E of `docs/roadmap/NEXT_BUILD_ORDER_2026-11-04.md` under the product contract in
`docs/product/WHISPER_CALL_COPILOT.md`, on top of PR D (`CALL_COPILOT_INGRESS.md`). Backend only. Nothing here
activates a provider, calls a model, adds a route or UI, or changes pricing._

## What this PR is

Given a human-first inbound call whose **both parties consented** (PR D), it can

1. store **transcript segments** that are tenant-bound and gated at their exact captured time,
2. record a **stable evidence revision** with truthful coverage,
3. run a Gradia-owned, bounded **extractor seam** (fixtures only) and validate its output strictly,
4. turn that output into **source-cited, approval-required proposals** using the existing customer/vehicle
   resolution, and stage the executable ones as ordinary `pending_actions`,
5. re-verify consent, evidence, payload, requester, agent definition and CRM identity **inside the existing
   `control_claim`** at approval, **and again immediately before each effect that runs after that claim commits**
   (booking, draft quote, text), so the existing executor is the only thing that ever acts and a late decline or change
   is caught before the effect.

Creating a proposal grants **no execution**. No CRM, quote, booking, task or message row is written, nothing is
sent, no memory is published, nothing is retried, and autonomy is not expanded.

```
 consented call (PR D ledger)
   -> record_segment   gate at the segment's exact time, redact first, append-only, replay/conflict by digest
   -> seal_evidence    digest-identified revision + coverage (complete only if attested AND every check passes)
   -> proposeFromCall  gate(model_use) -> gated read -> extractor seam -> strict schema -> CRM resolution
                       -> deterministic planner -> ONE atomic record_extraction
        executable  -> pending_actions (APPROVAL REQUIRED, existing action types, stable command id)
        otherwise   -> review-only proposal with a reason
   -> human approves in the existing queue -> executeApproval -> claim_control_action -> control_claim
        control_claim now first asks call_copilot_claim_recheck(...) which can only DENY
        record commands (customer, vehicle, note) are applied inside that same transaction
        booking / quote / text run afterwards: the executor calls call_copilot_pre_effect_recheck(...) right before the effect
```

## Reuse inventory (no parallel CRM, executor or memory)

| Need | Reused | Notes |
| --- | --- | --- |
| Consent and capture state | PR D `call_copilot_capture_state` / `call_copilot_assert_capture`, `requireCaptureGrant` | Derived purposes (`model_use`, `extraction`, `crm_mutation`) at the exact captured time |
| Execution authority | `pending_actions`, `claim_control_action` -> `control_claim`, `executeApproval`, `control_execution_decisions` | One executor. `control_claim` gains one block that only denies |
| CRM operations | `resolve_customer`, `update_customer` (customer + vehicle), `record_interaction` (note), `create_quote`, `book_appointment`, `send_sms` | Existing action types and payload contracts (`record-command.ts`, `mcp/proposal.ts`, `QuoteProposal`) |
| Identity | `customers.phone_canonical` / `email_canonical`, `normalizeDestination`, `forShop` | Exact canonical match only; no fuzzy link |
| Policy | `control_guard_staging` trigger, `control_pending_mode` | Staging a type the active policy does not permit falls back to review-only |
| Agent lifecycle | `agent_definition_state` | Optional exact active revision binding, re-checked at approval |
| Memory | none, **deliberately** | Customer-specific memory stays a review-only proposal. The reviewed-memory store and its retrieval are shop-wide, so there is no path from a call proposal into it (see Memory) |
| Tenant facade | `forShop`; every new table is RLS-on with no browser grant | |

Existing behaviour is unchanged except `control_claim` (below), the owner-readable denial strings in `approvals.ts`, and
three `denyBeforeEffect(...)` calls in the booking, draft-quote and text executors (inert for every action that is not a
Call Copilot proposal). The migration is additive; the upgrade probe proves every existing table, grant, policy, trigger and
constraint, and the ACLs of the claim functions, are byte-for-byte unchanged.

## Objects (migration `20261120140000_call_copilot_proposals.sql`)

Tables (all append-only; UPDATE/DELETE/TRUNCATE refused; a shop delete cascades):

| Table | Holds | Who can read |
| --- | --- | --- |
| `call_copilot_transcript_segments` | speaker, captured start/end, text (redacted), content digest | **No role** (only the gated functions) |
| `call_copilot_transcript_conflicts` | a provider changed a segment id / reused an index | No role |
| `call_copilot_evidence_revisions` | revision, evidence digest, coverage + reasons, capture state snapshot | service role |
| `call_copilot_extraction_runs` | one terminal run per identity; failures and unknown outcomes visible | service role |
| `call_copilot_proposals` | kind, route, staged payload, cited fields, ambiguity, CRM binding | service role |
| `call_copilot_run_proposals` | which proposals a run produced or deduplicated onto (a replay answers with exactly these) | service role |

Functions: service-role writers/readers `call_copilot_record_segment`, `call_copilot_seal_evidence`,
`call_copilot_read_transcript`, `call_copilot_record_extraction`, `call_copilot_find_unknown_run`; the only function
an API session can run is the **read-only** `call_copilot_pre_effect_recheck` (the service role, or the approving owner /
manager session, verified inside; it answers only a denial code for a proposal of the caller's own shop). Internal helpers
(`actor_ok`, `evidence_snapshot`, `evidence_is_current`, `assert_span`, `resolve_fields`, `customer_binding`,
`recheck`, `claim_recheck`, `luhn`, `has_card_number`, `segment_digest`) are callable by no API role. There is **no** memory
submission function, table or grant.

## Transcript evidence and the gate

* A segment is stored only if the PR D gate passes **at its exact captured time** and the whole span lies inside
  **one** consented interval. Declined, missing, version-mismatched, paused-gap, stopped, unknown or conflicting
  consent stores nothing. The gate runs before anything is written, including conflict rows.
* Transcript **storage and reading are gated as derived uses** (purpose `extraction` / `model_use`), not live
  `transcription`: provider transcripts normally arrive after the audio was captured, and the live purposes require
  capture to be active *now*. The live purposes remain for the future provider seam.
* Payment-card data is redacted before storage (digits, spelled-out digits, card security codes, national ids, bank
  numbers, spoken credentials) and the database independently refuses a Luhn-valid number laid out like a card. The
  database check is structural (13-19 contiguous digits, 4-4-4-x, 4-6-5) so UUIDs and timestamps can never match; this
  was a real intermittent failure found by the integration tests and is regression-tested over 20,000 random strings.
* Derived uses (sealing, reading for a model, extraction, approval) are re-gated at the call level **and** the evidence
  snapshot re-verifies that **every stored segment's span still lies inside a consented captured interval**, so a cited
  segment is checked at its own captured time every time the evidence is used, including at approval.
* Replay: same segment id and digest is `duplicate`; the same id or index with different text is `conflict`, recorded,
  and fails the whole call closed for sealing, reading, extraction and approval.

### Evidence revisions and coverage (truthful, never inferred)

`call_copilot_seal_evidence` folds the ordered segments, the attestation, and the PR D capture state (status,
intervals, gaps, conflict counts) into one digest. The same evidence returns the same revision; any change (a new
segment, a call-ended event, a pause) makes a new digest and the old revision **stale**: it cannot be read for a model,
used for extraction, or used to approve a proposal.

`coverage_status = complete` requires **all** of: provider attestation (`declared_final` + expected segment count),
call ended, no unknown outcome, no mid-call capture gap, contiguous segment indexes 0..n-1, and a matching count.
Anything else is `partial` with the reasons (`completion_not_attested`, `call_not_ended`, `provider_outcome_unknown`,
`capture_gap`, `segment_holes`, `segment_count_unconfirmed`, `segment_count_mismatch`). Unknown completion is partial.
The extractor receives the coverage and the proposals carry their revision, so partial is never presented as complete.
The span before consent is recorded as a gap and is never backfilled. Provider acceptance is not proof of completeness.

## The extractor seam

`CallExtractor { id, version, extract(input, {signal}) }` is the only contract. Input is `{ schemaVersion, coverage,
segments[] }`: transcript text as **data**; there is no field for instructions, tools, tenant, policy or permission.
Output is validated against a **strict closed schema** (`extraction-schema.ts`): ten proposal kinds, every field with
qualitative confidence and 1-5 transcript-span citations; unknown keys (a tenant, an action type, a price, "approved")
fail the whole output. Bounds: 600 segments / 120,000 characters / 30 s. A deadline overrun or a thrown error is
`unknown_outcome` (the seam may have processed the transcript) and **is never retried automatically**; a later request
for the same evidence and extractor identity is refused before the seam is called. Only a seam that can prove nothing
was sent may report `failed_before_effect`. No implementation calls a live model or provider; the tests use a
scripted fixture extractor.

## Proposals

Every proposal starts **APPROVAL REQUIRED** (`initial_mode` is a constant column). Gradia's planner, not the model,
decides the route:

| Proposal | Route | Existing operation / why not |
| --- | --- | --- |
| Create / link customer | staged `resolve_customer` | exact canonical phone/e-mail only. Several matches = ambiguity, a conflicting heard value = review, a name alone = review, a phone without `+country` = unsupported (never guessed) |
| Create / link vehicle | staged `update_customer` (vehicle block) | exact customer + vehicle snapshot. Fill-only; a different make is a conflict / second-vehicle review |
| Requested service / condition / location; timing / constraints | staged `record_interaction` (note) | needs one resolved customer; lineage (call id, evidence revision) in the note metadata |
| Quote draft | staged `create_quote` | service **names** only; the existing executor prices a draft from the menu at approval and never sends. No price is ever extracted |
| Appointment draft | staged `book_appointment` | only with a **grounded** start and duration (below), a future start and high confidence; availability is re-checked by the booking executor. Unsupported or ambiguous timing is review-only |
| Message draft | staged `send_sms` | to the CRM's own number, strictest category (`marketing`: needs the destination's own consent at send time); links, numbers, e-mails and sensitive data make it review-only |
| Lead source / stage / owner / next action | **review-only** `no_guarded_executor` | no guarded operation updates an existing lead |
| Follow-up task | **review-only** `no_guarded_executor` | there is no task table or executor |
| Customer-specific memory candidate | **review-only** `customer_memory_review_only` | never staged, never handed to the shop-wide reviewed-memory store (the table refuses an executable one) |

Anything ambiguous, conflicting, low-confidence, ungrounded (an identifier not literally in its cited words),
unverified (no verified phone), or blocked by the active policy is review-only with a stable reason code. Text that
instructs the assistant (classified over the **whole cited segment**, not just the span) or that carries card or other
sensitive data is **refused**: dropped, counted on the run, never staged or shown for approval. Dependents (vehicle,
notes, quote, booking, message, memory) are only proposed against ONE resolved customer; a new customer is created only
on approval, so dependents wait (re-run after approval: the CRM context digest makes it a new run).

Identity of everything (every execution-critical input is part of it, so nothing can be answered with, or deduplicated onto, a
proposal made under different authority, for a different subject or against a different binding):

* `run_key` = evidence digest + extractor id/version + schema + CRM context digest (the CRM facts **and the shop timezone** the plan was
  built from) + **requesting member** + **exact agent definition binding** (agent id and revision, or none).
* `proposal_key` = digest of the staged content **and** confidence, ambiguity, customer, vehicle, the CRM identity snapshot the database read,
  the definition binding and the requesting member. Identical words about a *different* known customer, under a different definition or
  from a different requester are a different proposal. Deduplication is only ever onto an identical one, per evidence revision.
* The pending-action id (the stable command id) = hash of shop, call, evidence revision and proposal key.
* `call_copilot_run_proposals` lists, in order, every proposal a run produced **or deduplicated onto**. A fresh answer and every replay
  therefore name the same proposal ids (before this, a deduplicated proposal was omitted from the new run's answer and a replay could not
  see it). Two members who ask for the same extraction get two runs and two sets of proposals, each approvable only while its own requester
  is still authorized.

Citations are re-resolved **by the database**
against the stored transcript (speaker, captured time, exact-span digest), never trusted from the caller.

## Appointment timing is grounded, not trusted

A well-formed future ISO timestamp with a citation is not enough. `timing-grounding.ts` (deterministic, Gradia-owned) requires the cited words
to literally say the moment, in the **shop's timezone**, and anything it cannot positively verify stays review-only:

* **Start**: exactly one explicit date (a month **name** and a day) and one explicit clock time (a.m./p.m., 24-hour `HH:MM`, or "noon") that
  equal the proposed instant rendered in the shop's timezone. The model's own UTC offset is never trusted (the instant is compared). A named
  weekday must match. A year-less date must be its next occurrence on or after the day of the call (a far-future year cannot ride a month/day
  citation). Relative dates ("tomorrow", "next Friday"), numeric dates ("12/4"), a bare hour, two candidate dates/times, ranges, and an unknown
  or invalid shop timezone are unsupported. Reasons: `start_ungrounded`, `start_ambiguous`, `timezone_unknown`.
* **Duration**: exactly one explicit length in the cited words equal to the proposed minutes ("180 minutes", "two hours", "an hour and a half").
  Missing, different or plural is `duration_ungrounded` / `duration_ambiguous` (`duration_unconfirmed` when none was proposed).
* **Hedging anywhere in a cited utterance** ("maybe", "around", "or", "if", "actually", "not sure", "between", ...) makes the field ambiguous,
  including words *next to* a narrow citation.
* Fixed-point of the design: this only ever keeps a proposal review-only; it cannot make anything executable. It is intentionally
  conservative, so many real calls ("tomorrow at nine") will be review-only until a human confirms; that is the point. A booking whose time has
  passed by approval is refused (`call_proposal_expired`).

## Approval-time recheck (inside the existing claim)

`control_claim` is identical to its previous definition except for three marked lines (a declaration, one call, one
leading `WHEN` in the reason chain); a unit lock and the upgrade probe assert this. The call is
`call_copilot_claim_recheck`, which returns NULL for every action that is not a Call Copilot proposal and otherwise can
only deny. Denials are audited in `control_execution_decisions` and leave the action pending (never consumed):

| Check | Denial |
| --- | --- |
| Any operative payload field edited (executor annotations are ignored) | `call_proposal_edited` |
| Requesting member still an active owner / manager with `crm.read` | `call_requester_revoked` |
| PR D gate for `crm_mutation` (declined, stopped, gap, conflict, unknown...) | `call_consent_unavailable` |
| Sealed evidence still exactly current | `call_evidence_changed` |
| Bound agent definition revision still active | `call_definition_inactive` |
| A proposed appointment time has not passed | `call_proposal_expired` |
| CRM customer exists and the identity fields the proposal used are unchanged | `call_crm_state_changed` |

Membership of the **approver**, current Control Center policy, and the exact `update_customer` snapshot are still checked by the unchanged
claim. The recheck takes a shared lock on the call row, so for **record commands** (customer, vehicle, note), which are applied inside the same
transaction, consent cannot change between the check and the write.

### Effects that run after the claim: the pre-effect recheck

A booking, a draft quote and a text cannot be applied inside the claim transaction: they run afterwards in application code (and, for a text, at
a provider). A late decline, an evidence change, a revoked requester, a retired definition or a changed customer identity between the claim and
the effect used to be invisible to them. Now `approvals.ts` calls `denyBeforeEffect(...)` (`src/lib/approval-pre-effect.ts` ->
`call_copilot_pre_effect_recheck`) immediately before:

| Effect | Where the recheck runs |
| --- | --- |
| Booking | before the first domain write (customer resolution) **and** again immediately before the authoritative appointment write |
| Draft quote | before customer resolution / the vehicle upsert / the quote insert |
| Text | after the send policy, before any proof is consumed and before the provider is asked |

The database answers `{ok:true}` for every action that is not a Call Copilot proposal (the unchanged path). For a proposal it additionally
requires that the action **was claimed by a person** (status approved, a human decider) and re-runs exactly the claim's recheck (payload
unedited, requester, consent for CRM mutation, evidence current, definition, CRM identity, appointment not expired) against the same pending
action, proposal, evidence revision and definition. **Anything but an explicit `ok:true` is a denial**: an error, a thrown exception or a
malformed answer fails closed, the claim is released (the action returns to pending, nothing consumed), and the denial is audited next to the
claim's own decision row in `control_execution_decisions` (once per reason).

Deviation from "service-only": the function is also granted to `authenticated`, because in the owner's dashboard path the executor runs with
the **approver's own session**, not the service role, so a service-only grant would leave exactly that path unchecked. It is read-only (one
audit row on denial), verifies the caller inside (the service role, or an active owner / manager of that shop; anyone else gets `42501`), and
returns only a denial code for a proposal in the caller's own shop.

**Honest limit.** The window between authorization and effect is now the few statements between the recheck and the effect; it is not zero. A
database read cannot be made atomic with an external provider call, so a decline recorded *after* the recheck but *before* the provider
accepts the request is not caught. Record commands do not have this window (they apply inside the claim).

## Memory

A memory proposal is **review-only for good** in this PR. It writes to no memory table and has **no path** into the existing reviewed-memory
system: there is no submission function, no hand-off table and no grant (an earlier draft of this PR had an owner-session
`call_copilot_submit_memory_candidate` that created a normal reviewed-memory candidate; it was removed). The reason: the reviewed-memory store
is shop-level and its retrieval is shop-wide, so a published *customer-specific* entry would be retrievable for **every** customer. Marking
the text with a customer id in its content does not scope retrieval and is not a control. The planner never stages one, the database refuses to
(`CHECK (kind <> 'memory_candidate' OR route = 'review_only')` plus an explicit raise in the writer), a source lock asserts no Call Copilot SQL or
TypeScript references reviewed memory, and the probe asserts it. A hand-off may be added only when **customer-scoped publication and
customer-scoped retrieval exist end to end** (and the review UI shows the scope).

## Security notes

* Tenant: the shop id is always a server-resolved argument; no role can read transcript text; another shop's call id,
  segment, revision or proposal is indistinguishable from a missing one; revoked members lose every path immediately.
* Prompt injection: structural (closed vocabulary, Gradia-owned mapping, no tool/policy/tenant field) plus a classifier
  and strict output validation. A planted instruction stages nothing, and an injected action type, tenant, price or
  approval flag fails the schema.
* PII: transcript text is the only place speech is kept; card and national-id data are redacted before storage;
  proposals carry only the fields needed; the proposal and run tables store digests of the quoted spans, not the spans.

## What is NOT built (explicit)

* No route, no UI, no provider seam implementation, no live model; `src/lib/call-copilot/*` is imported by nothing
  outside itself (source-locked). No retention job (12-month transcript retention needs the privacy review).
* No automatic CRM mutation, booking, quote send, message, memory publication or retry; no autonomy change.
* No lead update, follow-up task or customer-scoped memory executor (see below).
* No legal disclosure wording or jurisdiction logic. The PR D rule stands: both parties on the same disclosure version.

## Known limitations and findings for the next PR

1. **Customer memory scope.** The existing reviewed-memory store is shop-level and its retrieval is shop-wide, so customer-specific
   memory is review-only here with no hand-off (see Memory). It needs customer-scoped publication AND retrieval, end to end, first.
2. **No extractor output cache.** A repeated request for the same evidence re-invokes the extractor and is then
   deduplicated in the database (identical proposals are not duplicated). Unknown outcomes are never re-invoked. A live
   seam must add a result cache keyed by evidence digest + extractor identity before activation.
3. **Review-only kinds.** Lead stage/owner/next action and follow-up tasks need guarded executors (and a task table).
4. **Customer-dependent ordering.** Approving a customer or vehicle command changes the customer version; the vehicle
   command carries the customer's exact snapshot and must run first (the reverse is refused, writes nothing, and the
   proposal can be re-created). Proposals bind only the identity fields they used, so a note or quote is not staled by
   an unrelated field filling in.
5. **Phones need `+country`.** `normalizeDestination` never guesses a country code, so a number heard without one is
   review-only. A shop-region default would be a policy decision.
6. **Pre-effect window.** The recheck runs immediately before each post-claim effect, not atomically with it (see above). A decline
   landing between the recheck and the provider call is not caught.
7. **Timing grounding is conservative.** Only month-name dates with an explicit clock time and an explicit length are executable;
   relative and numeric dates are review-only until a human confirms. The hedge list is deliberately broad (a stray "or" or "not" in the same
   utterance makes timing ambiguous). Only English month names are recognised.
8. **Authority duplicates.** Two members asking for the same extraction get separate proposals (and separate pending actions) bound to
   their own authority; approving one does not consume the other.
9. **Policy fallback is sticky.** A proposal that fell back to review-only because the Control Center policy did not permit staging is
   deduplicated onto by an identical later request even if the policy then allows staging; re-extract with a changed input to restage.
10. **Staleness by design.** A late `call_ended`, new segment or pause changes the evidence digest and makes existing
   proposals stale; re-seal and re-extract.
11. **Approving unknown extraction outcomes** has no UI: a human reconciliation path for an `unknown_outcome` run is not
   built (the run is visible in `call_copilot_extraction_runs`).
12. Segment limits (600 / 120,000 chars) refuse a very long call rather than chunking it.

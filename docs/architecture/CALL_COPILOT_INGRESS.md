# Call Copilot ingress and consent evidence (PR D)

_2026-11-19. Implements PR D of `docs/roadmap/NEXT_BUILD_ORDER_2026-11-04.md` under the
product contract in `docs/product/WHISPER_CALL_COPILOT.md`. Backend only. Nothing here
activates a provider, records audio or calls a model._

## What this PR is

A durable, tenant-isolated, append-only evidence ledger for **human-first inbound calls that
traverse a Gradia-controlled path**, plus the deny-by-default gate every later Call Copilot
capability must pass. It answers one question truthfully and fails closed on everything else:

> For this shop's call, have **both** parties (operator and caller) been disclosed to and
> consented, and has nothing since withdrawn or clouded that consent?

## What is built

| Piece | Where | Notes |
| --- | --- | --- |
| Migration (objects only) | `supabase/migrations/20261119130000_call_copilot_ingress.sql` | Three tables, seven functions (three entry points, four internal helpers). No existing table, column, trigger, policy, grant or row is changed |
| Evidence ledger | `call_copilot_calls`, `call_copilot_events`, `call_copilot_conflicts` | Append-only (UPDATE/DELETE/TRUNCATE refused; a shop delete still cascades). RLS on; **no** browser-role grant at all; the service role can only `SELECT` |
| Only writer | `call_copilot_record_event(...)` (service role) | Atomic, serialised per call, idempotent, replay-checked |
| Consent state machine | `call_copilot_capture_state(shop, call)` | Pure fold over the contiguous sequence prefix. Same result for every arrival order |
| Gate | `call_copilot_assert_capture(shop, call, purpose, at?)` | Raises `CC403` unless consent evidence supports the purpose |
| Typed adapter | `src/lib/call-copilot/{events,ingress,capture-gate,provider-seam}.ts` | Strict zod vocabulary; `recordCallCopilotEvent`; `requireCaptureGrant` / `CaptureGrant`; the provider-seam contract and `handleCallCopilotCallback` |
| Tests | `eval/call-copilot-*.test.ts` (35 unit), `eval/integration/call-copilot-ingress.int.test.ts` (53), `scripts/verify-call-copilot-migration.py` | See "Evidence" |

### Events (all content-free, closed vocabulary)

`call_opened` (sequence 1 only; carries the route kind and optional region codes),
`disclosure_delivered` (party, opaque disclosure version), `consent_granted` /
`consent_declined` (party, version, the disclosure sequence answered),
`capture_paused`, `capture_resumed`, `capture_stopped`, `call_ended`,
`provider_outcome_unknown` (reason code), `participant_added`.

There is **no** column or field for audio, a transcript, speech text, a phone number, a name or a
free-text note, and every schema is strict, so a payload that tries to carry one is rejected and
nothing is stored. The disclosure version is an opaque reference: **no disclosure wording is
stored, implied or approved here.**

### Idempotency, replay and ordering

* Every event has a provider event id **and** a per-call `sequence` assigned by the
  Gradia-controlled path. The database computes a digest from the typed columns itself.
* **Exact replay** (same id, same digest) returns `duplicate`; nothing is written. Verified under
  12-way concurrency.
* **Changed replay** (same id, different content) or a **reused sequence** returns `conflict`,
  stores the conflict, writes no event, and **fails the whole call closed**
  (`uncertain / conflicting_replay`) for capture and every derived use. Repeats do not pile up.
* A provider call id belongs to exactly one shop (globally unique). Another shop presenting it gets
  `foreign_call` and nothing is written; it cannot read, gate or poison that call.
* Writers for one call are serialised on the call row, so two simultaneous first deliveries record
  once, and two shops racing for a new call id produce exactly one owner.

### The consent state machine (order-independent)

Only the **contiguous** prefix `1..k` is folded. A missing sequence is "unresolved": the call is
`uncertain / sequence_gap` and capture and derivation are denied until it arrives. That is what
makes a reordered callback unable to manufacture consent: a "granted" at sequence 5 is never
honoured while a decline, pause or disclosure at sequence 3 may still be in flight, and once
everything has arrived the answer equals the in-order answer.

Capture becomes active only when **both** parties have a `consent_granted` that cites a
`disclosure_delivered` of the **same party and same version** with an **earlier sequence**, after
any pause, **and both parties consented to the same disclosure version**. The fold keeps each
party's consented version (not a boolean): operator consent to version A with caller consent to
version B never activates or resumes capture, whatever the arrival order. A party's later valid
consent replaces its earlier one, so a mismatch is repaired only by a party validly consenting to the
other's version. A consent without a valid disclosure reference is recorded but ineffective (listed in
`ignored`); a version mismatch leaves both consents valid and capture simply off (`awaiting_consent`).

| Event | Effect |
| --- | --- |
| `consent_declined` (either party) | Final for the call, honoured even without a valid reference. Nothing re-enables capture or any derived use |
| `capture_paused` | Closes the consented interval, opens an explicit **gap**, voids all consent |
| `capture_resumed` | Effective only after a pause **and** fresh disclosure + consent from both parties **on the same version**. Otherwise recorded as ignored and capture stays off |
| `capture_stopped` / `call_ended` | End capture. Nothing restarts a closed call |
| `provider_outcome_unknown` | Ends capture, status `unknown_outcome`, the gap stays open. Never reported as complete, never replayed |
| `participant_added` | Ends capture (`unconsented_participant`): all-party consent cannot cover someone who was never asked |
| clock regression | `uncertain / time_regression`, denies everything |

State also reports consented `intervals` and explicit `gaps` (before consent, paused, stopped,
unknown outcome, ...). Uncaptured time is never backfilled: the gate refuses a stated moment inside
a gap, for live and derived purposes alike.

### The gate

`call_copilot_assert_capture` knows six purposes. **Live** (`recording`, `transcription`) require
capture to be active now and never before the current consented interval began. **Derived**
(`model_use`, `summarization`, `extraction`, `crm_mutation`) require intact consent evidence and at
least one captured interval (and, if a moment is given, that it lies inside one). Declined,
missing, unavailable or uncertain consent denies all six; so does any failure to ask. In TypeScript,
`requireCaptureGrant` returns a frozen, branded `CaptureGrant` or throws `CaptureDeniedError`; a
database error or an unreadable or contradictory answer is a denial.

**A grant is necessary, not sufficient.** It says nothing about Control Center policy, approval,
membership or CRM authority, and does not claim a recording is complete.

## What is NOT built (explicit)

* **No route and no provider implementation.** `CallCopilotProviderSeam` and
  `handleCallCopilotCallback` define and test the contract only; a source-lock test keeps every
  route, page, action and cron from importing the module. Reason: the existing verified Twilio
  contract is the inbound **SMS** signature check plus the receptionist voice path. Nothing in it can
  place a disclosure, collect each party's response, bridge a human call or assign a per-call
  sequence, so any route today would either invent those events or imply provider activation. A
  seam implementation must verify the provider signature on the raw request, resolve the shop from
  Gradia's own number binding (never a payload field), confirm a Gradia-controlled route, and assign
  `sequence` from a Gradia-owned per-call counter, not from vendor retry order. No Next.js route
  code was written, so no route documentation was needed.
* No audio, recording, transcription, summarization, model call, extraction or CRM proposal or
  mutation. No `call_records` or `interactions` writes: the receptionist artifact is **untouched**
  (migration fingerprint-checked) and a later PR links to it.
* No user-facing UI, operator pause control, or owner read access (RLS grants browser roles nothing).
* No outbound AI calls, silent interception, deploy, shared database or production data.
* No legal disclosure wording, no approved disclosure versions, no jurisdiction interpretation. Region
  codes are stored as evidence and not interpreted; all-party consent is the only rule.
* No per-shop enablement (the matrix says capture is OFF until configured). The gate is the consent
  half; a later PR must AND it with Control Center policy.
* No retention job. The ledger holds only minimal non-content safety evidence; its retention schedule
  belongs to the separate safety-retention review in `GRADIA_MEMORY.md`.
* Two-party calls only. A conference or transfer must emit `participant_added`, which ends capture.

## Relationship to the lifecycle PR

The build order says this PR depends on lifecycle and unknown-outcome semantics. The call path chosen
here needs only **evidence**: `provider_outcome_unknown` is recorded and denies capture, and nothing
in this PR retries, resends or replays anything. It does not touch the run lifecycle executor, and a
later provider activation should still follow the lifecycle's reconciliation conventions.

## Evidence (disposable `gradia-isolated-tests` stack, Node 24.15.0)

* Upgrade probe `scripts/verify-call-copilot-migration.py`: PASS. It applies the real SQL on the
  pre-migration schema in a rolled-back transaction and proves `call_records` is byte-for-byte
  unchanged (rows, columns, policies, grants, triggers, constraints) and its upsert still works, RLS and
  ACLs, append-only, replay, conflict, tenant, reorder, decline, pause/gap and gate behaviour. Four
  deliberate mutations (pause keeps consent, fold past gaps, replay ignores digest, gate permits all)
  each make it FAIL. It requires a stack that does not yet hold the migration.
* Integration `call-copilot-ingress.int.test.ts`: 53 tests, 3 consecutive runs green (11 cover the same-version rule, below). Includes
  **all 120 arrival orders** of the five consent events (safe at every step, converging on the
  in-order result), seeded shuffles of the decline and pause/resume scenarios, 5 concurrent shuffled
  deliveries, 16-way concurrent first delivery, the two-shops race, privilege checks (service role
  direct writes, owner session and anon refused) and cascade on shop delete. Swapping in a
  gap-ignoring state function makes the four reorder/gap tests fail.
* Unit: 203 files, 3209 passed, 4 intentional skips. `tsc --noEmit` and ESLint on the touched files clean.
* Neighbours: `vapi-replay` 14, `customer-merge` 9, `tenant-isolation` 8, `provider-events` 15 pass.
  `tenant-relationships` has one failing test (`real recipient lookups reject cross-shop IDs...`) that
  fails identically with this migration removed (send-policy, unrelated).

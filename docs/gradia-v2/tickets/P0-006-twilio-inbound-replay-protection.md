# P0-006 — Twilio inbound replay protection

- **Ticket ID:** P0-006
- **Epic:** E00 — Stabilization
- **Status:** **done** (2026-08-14 — merged to `main` in PR #19, commit `76847e4`; independent Cursor verdict **APPROVE / safe to merge**, no BLOCKER or HIGH findings, no review-fix commit required; founder real-Twilio staging acceptance completed pre-merge; close record at the end of this file)
- **Priority:** High

## Objective

Apply the P0-005 idempotency mechanism to the inbound Twilio SMS webhook so that a provider retry of the same `MessageSid` produces exactly one interaction, one classification (one Claude spend), one consent-ledger evaluation, and one set of staged approval cards — instead of duplicates of each.

## User outcome

An owner never sees duplicate approval cards or duplicate customer messages in a thread because Twilio retried a delivery; the shop is never billed twice in credits/LLM spend for one inbound text.

## Current code references

- Audit doc 04-F: "**No inbound idempotency:** no dedupe on `MessageSid` — a Twilio retry duplicates interactions, Claude calls, and approval cards."
- Inbound pipeline: `api/twilio/sms/route.ts` — shop by `To` number → HMAC-SHA1 signature verify (`twilio.ts:105-168`) → `findOrCreateCustomer` → `recordInteraction` → STOP/START consent ledger → rate-limited Haiku classify → staged reply draft + `proposeLead` (`route.ts:341`); YES-confirmation handling at `route.ts:192-215`.
- P0-005's mechanism (per ADR-001) — this ticket consumes it, never invents a second one.
- Decision: **D-023** (provider events idempotent, DB-enforced).

## Exact scope

1. At the top of the inbound SMS handler, after signature verification succeeds: claim `(provider='twilio', event_id=MessageSid)` via the P0-005 mechanism. Duplicate → return the same success TwiML (empty) immediately, info-log, zero side effects. Claim must happen BEFORE any write or LLM call.
2. Claim-then-process ordering: if processing fails after a claim, the handler must not strand the event unprocessably — define behavior per ADR-001 (e.g. claim row records outcome; a failed processing releases or marks the claim so Twilio's next retry can reprocess). This failure semantics is the heart of the ticket; lock it with tests.
3. Ensure the STOP/START consent path stays correct under dedupe: a replayed STOP must not double-append ledger entries, but a *new* STOP message (different MessageSid, same content) still processes.
4. Verify the status-callback route is untouched (that's P0-008) and A2P callbacks are out of scope.

## Explicit non-goals

- No changes to signature verification, per-shop credential resolution, classification behavior, or staging logic.
- No Aurinko email dedupe (same pattern, separate follow-up ticket — noted for the backlog).
- No Vapi (P0-007). No status callback (P0-008).
- No retry/queue infrastructure.

## Dependencies

P0-005 (mechanism + constraints). P0-002 (gating CI).

## Expected modules affected

`api/twilio/sms/route.ts`; the P0-005 helper module; tests.

## Database impact

Rows in the P0-005 claim structure (or unique key usage). No new tables/columns beyond P0-005's.

## Migration impact

None (P0-005 delivered the schema).

## API impact

Webhook response behavior on duplicates: identical success response (Twilio must see 200 + empty TwiML both times — a non-2xx on duplicate would cause more retries).

## UI impact

None directly; the user-visible effect is the *absence* of duplicate cards/messages.

## Permission impact

None.

## Tenant-isolation impact

Claim key scoped per ADR-001 (MessageSid is globally unique at Twilio, but the claim row still carries the resolved shop_id for audit).

## Security impact

Dedupe must occur strictly AFTER signature verification (a forged request must never be able to claim/poison a real future event's id).

## Idempotency requirements

Exactly-once side effects per MessageSid across: interactions insert, consent ledger, classifier invocation, approval-card staging, credit metering. DB-constraint-enforced, not read-check.

## Observability requirements

Info log per suppressed duplicate with MessageSid + shop id; count visible in logs for P0-012's later alerting ("duplicate messaging" runbook references this signal).

## Analytics requirements

None owner-facing.

## Feature flag

None — fix, not feature. A flag that re-enables duplicate processing has no legitimate use; rollback is by revert.

## Automated tests

- **Idempotency replay (the core):** deliver a signed webhook payload twice (and 5×) → exactly one interaction row, one classify call (mock counted), one staged card set, one meter row; each duplicate returns 200 empty TwiML.
- **Failure-path:** processing throws after claim → per-ADR semantics: Twilio's retry CAN reprocess (no permanently stranded message); locked by test.
- **Ordering:** unsigned/forged request never creates a claim.
- **Consent:** replayed STOP → single ledger entry; fresh STOP (new sid) → processed.
- **Integration (DB tier):** replay against real Postgres constraints.
- Extend the existing webhook forgery/tamper/replay suite (`eval/webhooks.test.ts`) rather than parallel-tracking it.

## Manual acceptance procedure

1. In staging, send a real (or Twilio-CLI-simulated) inbound SMS → card + interaction appear once.
2. Capture the exact request; replay it with identical signature → 200, no new interaction, no new card, log shows duplicate suppression.
3. Send STOP; replay it → one opt-out ledger entry; send START (new message) → processes normally.
4. Kill the classifier (unset key in staging) mid-flow after claim; confirm the retry path reprocesses per the ADR semantics once restored.

## Failure cases

- Duplicate arrives while the first is still mid-processing (concurrent, not sequential) → constraint makes one winner; loser exits cleanly. Test with parallel requests.
- Claim storage unavailable → fail closed (500 → Twilio retries later) rather than processing unguarded; never process-without-claim.
- Same customer texts identical content twice legitimately → two MessageSids → both process (dedupe is by sid, never by content).

## Rollback strategy

Revert the handler commit; claim rows are inert. No migration to reverse.

## Definition of done

All of `../12-definition-of-done.md` plus: replay tests green in gating CI including the DB tier; manual staging replay evidenced in the completion report; forgery-before-claim ordering locked by test; webhook suite extended, not weakened; duplicate-suppression log line documented in `../runbooks/duplicate-messaging.md`.

## Completion record (Builder, 2026-08-13)

Implemented on `fix/p0-006-twilio-replay`. Summary (full report in the Builder
session handoff):

- **Route:** `src/app/api/twilio/sms/route.ts` claims
  `(provider='twilio', event_id=MessageSid)` via the P0-005
  `claimProviderEvent` strictly AFTER signature verification and strictly
  BEFORE any write/LLM call (ADR-001 C3). Duplicates
  (`duplicate_completed`/`duplicate_processing`) return the same 200 empty
  TwiML with zero side effects and an info log carrying MessageSid + shop id.
  Signed requests missing `MessageSid` are acknowledged without processing
  (never process-without-claim). Claim-storage outage → 500 (fail closed).
- **Failure semantics (ADR-001):** processing failure → `failProviderEvent`
  + 500, so a provider retry reclaims (`reclaimed_failed`, attempts+1);
  crashed claimers age into `reclaimed_stale` (route `maxDuration` 60s <
  300s stale threshold — reclaim-while-running impossible). New throw
  points: interaction-insert failure, consent-write failure, classifier
  exception (metered first; the vendor_ref unique makes retry re-metering a
  no-op), lead-staging insert failure. On reprocess the interaction insert
  is deduped by sid lookup (race-free under the serialized claim).
  Complete-mark failure after successful processing logs and still returns
  200 (never retry into duplicates); the ADR-accepted at-least-once residue
  is a stale reclaim on an unusually late retry.
- **Consent:** replayed STOP/START applies once (claim-suppressed); a new
  sid with the same keyword still processes; consent write failures fail
  the claim instead of dropping compliance state silently. Policy unchanged.
- **Tests:** `eval/webhooks.test.ts` extended (+18 route-level tests:
  forgery-never-claims/no-poisoning ordering, duplicate suppression,
  fail-closed, retry semantics, consent replay, tenant-unresolved,
  malformed) — existing forgery suite untouched;
  `eval/integration/twilio-inbound-replay.int.test.ts` (9 DB-backed tests
  incl. 25-round genuine `Promise.all` duplicate-delivery stress per run;
  6 local runs = 150 rounds, zero flake; cross-tenant sid weaponization,
  failed-then-retry attempts accounting, ×5 replay, consent replay against
  real Postgres).
- **No schema changes, no migrations, no new dependencies.** Status/A2P
  callback routes untouched (P0-008); Vapi untouched (P0-007); production
  conflict enforcement remains OFF.
- **Validation:** `tsc --noEmit` clean · lint clean · Tier-1 547 green ·
  integration tier 7 files / 61 tests green · production build green.
- **Manual acceptance:** staging steps 1–4 assigned to the founder (Twilio
  CLI replay + classifier-outage retry per the procedure above); local
  equivalents executed via the integration suite.
- Runbook updated: `../runbooks/duplicate-messaging.md` documents both
  suppression log lines.

## Close record (docs-close session, 2026-08-14)

**Merged:** PR #19 → `main` as `76847e4` ("fix: harden Twilio inbound replay
handling"), 2026-08-14. Pre-squash branch commits: `afb542b` (Builder
implementation) → `89af55c` ("fix: make Twilio inbound metering retry-safe" —
a real reliability fix, not a Cursor review fix; see below). GitHub CI
ultimately passed: `ci / checks` · `ci-integration / integration` · Vercel ·
Vercel Preview.

**Review evidence:** independent Cursor verdict **APPROVE / safe to merge**;
**no BLOCKER or HIGH findings remained**; **no Cursor review-fix commit was
required**.

**Real-provider acceptance (founder, pre-merge):** completed against an
isolated staging/Preview Twilio path (not production customer traffic).
Covered: normal valid inbound delivery; replay of the same `MessageSid` with
no duplicate effects; the STOP consent flow; replay of the same STOP SID;
invalid/missing-signature rejection with no provider-event or business side
effects.

### Final architecture (as merged)

- P0-006 hardened **only the Twilio inbound SMS route**
  (`src/app/api/twilio/sms/route.ts`). Twilio delivery-status and A2P
  callbacks remain P0-008.
- Durable replay identity: Twilio `MessageSid` (with the `SmsSid` fallback
  already supported by existing parsing). The P0-005 `provider_events` table
  is the durable event receipt — **no Twilio-specific duplicate-receipt
  table was added; no new migration was required.**
- Required inbound ordering: request → resolve server-side Twilio
  credentials/shop → verify Twilio signature → validate `MessageSid` →
  claim `provider_events` → process the deterministic inbound workflow →
  complete the provider event. **Invalid/missing signatures cannot claim or
  poison a MessageSid** (ADR-001 C3, test-locked).
- Replay behavior: completed replay → 2xx/no-op; currently-processing
  duplicate → suppressed; genuine concurrent duplicate deliveries → exactly
  one business execution; failed event → retryable/reclaimable; a completed
  event cannot reopen; stale `processing` remains reclaimable under the
  existing provider_events policy, whose stale threshold stays above the
  route `maxDuration`.
- Replay protection covers: interaction persistence, consent effects,
  classification execution on ordinary completed replay, pending-action
  staging, usage metering, and downstream business effects.
- Consent: STOP/START and the currently supported consent keywords are
  protected from same-MessageSid replay — a replay does not reapply consent
  or duplicate evidence/actions; a genuinely new SID with the same keyword
  still processes. The consent policy itself was not redesigned; existing
  HELP behavior was not expanded.

### Metering reliability issue found by CI (`89af55c`)

The first CI run exposed a **real transient PostgREST/Kong failure** ("An
invalid response was received from the upstream server"): the inbound model
classification completed, but `recordUsage`'s prior best-effort behavior
swallowed the `usage_events` write failure — the provider event could then
complete with **no corresponding usage row**. This was treated as a real
reliability bug, not rerun as flaky CI.

Fix (`src/lib/credits.ts` + the route): `recordUsage` now returns
`written` / `duplicate` / `failed` while preserving its non-throwing
best-effort behavior for existing callers. **Only the Twilio inbound path
requires successful/durable classification metering before continuing:**
`written` → continue; `duplicate` → idempotent success, continue; `failed`
→ fail the provider event + HTTP 500 so the provider retries. A known
metering failure occurs **before** pending-action/card staging. The P0-005
`usage_events` unique (MessageSid as `vendor_ref`) remains defense-in-depth.

### Residual accepted risk (Cursor verdict — recorded, non-blocking)

After a genuine metering-write failure, a provider retry may **re-run the
external classifier**, because classifier output is not persisted. Accepted
as a non-blocking retry cost for P0-006 because: the first classification
output is discarded before any classification-derived business state is
persisted; interaction/consent pre-meter effects are deterministic and
idempotent; only the successful attempt stages classification-derived
state; user billing is not doubled; and eliminating it would require
broader classifier-output persistence. Tracked only as an optional
low-priority optimization unless future cost/reliability data justifies it.

### Tenant/security (as merged)

Tenant/shop resolution remains server-side — a request cannot directly
select an arbitrary `shop_id`; an unknown/unverifiable destination produces
no unsafe claim; authentication occurs before the `provider_events` claim;
the service-role-only provider_events protection remains intact; no secrets
were logged or persisted.

### Final validation evidence

TypeScript clean · lint clean · production build clean · unit suite green ·
integration suite green · P0-005 provider_events/ledger suites green ·
P0-003/P0-004/P0-004A regression suites green. Deterministic
metering-failure injection added; genuine `Promise.all` concurrent-delivery
tests; 25-round duplicate stress per run; the P0-006 suite repeatedly
exercised with **zero final flakes after the metering fix**.

### Follow-ups recorded at close (Organizer sequences)

1. **Consent-keyword customer-resolution failure:** review so a consent
   event can never be considered successfully complete without the required
   consent persistence.
2. Aurinko `accountId:`-prefixed event identity remains the ADR-001 C4
   follow-up.
3. **P0-005A** provider_events retention/pruning remains open.
4. Optional: use the already-trimmed MessageSid for metering-reconciliation
   consistency.
5. Optional: classifier-output persistence, only if future retry-cost data
   warrants it (residual above).
6. **P0-008 deferred findings** (deliberately not implemented here): the
   `sms/status` callback still lacks provider_events replay hardening;
   review query-string shop/token selection; review unknown-SID behavior;
   review stale/out-of-order status updates; review A2P subaccount
   credential/signature verification. Shared Twilio verification helpers
   were not redesigned by P0-006.
7. Production P0-004 conflict enforcement remains **OFF**.

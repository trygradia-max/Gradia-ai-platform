# P0-008 — Twilio subaccount status callback repair

## Ticket ID
P0-008

## Epic
E00 — Stabilization

## Status
**Done — merged to `main` 2026-08-25 in PR #23 (`1ea198f`; pre-squash Builder implementation `ffd6e01`).** Independent Cursor verdict **APPROVE**, no BLOCKER or HIGH findings. Founder acceptance **PASSED** on isolated local staging (both credential classes, forged/tampered/cross-tenant/unknown-SID negative paths, reconciliation clean). Full evidence, residual dispositions (M1/L1/L2/L3/L4), and follow-ups in the Close record below. The P0-006-deferred status-callback findings folded in at slotting are dispositioned there item-by-item. (Prior state: blocked — next implementation position from the 2026-08-14 P0-007 close, unblocked when `docs/close-p0-007` landed as `9babfcb` PR #22.)

## Priority
P0 — High. Delivery-status tracking is silently dead for exactly the shops the ISV model serves (Gradia-provisioned numbers), and the failure is invisible to owners.

## Objective
Fix `/api/twilio/sms/status` so signature verification resolves credentials in the same subaccount → BYO → env-master order as the rest of the Twilio integration, restoring delivery-status recording for shops on Gradia-provisioned (subaccount) numbers.

## User outcome
An owner on a Gradia-provided business number sees real delivery status on outbound texts (sent/delivered/failed) instead of a permanent silent blank — and Gradia can distinguish "sent" from "never arrived" for those shops.

## Current code references
- Audit trace F (`docs/audit/04-workflow-traces.md` §F), BUG (high confidence): "the status route resolves only BYO credential columns (`status/route.ts:75-83`), never subaccount fields — so for Gradia-provisioned numbers (signed with the **subaccount** token) verification fails and **delivery status is never recorded for exactly the shops the ISV model serves**."
- Correct resolution order lives in `twilio.ts:105-168` (subaccount → BYO → env master, per-shop creds, timing-safe HMAC-SHA1) — audit trace F inbound path.
- Feature-status matrix: "Message status / delivery — **BROKEN (subaccount shops)**" (`docs/audit/03-feature-status-matrix.md` §Communication).
- Status callback writes to `interactions.metadata` (audit trace F).

## Exact scope
1. Change the credential-resolution logic in `src/app/api/twilio/sms/status/route.ts` to reuse the same per-shop credential resolution used by the inbound SMS webhook (`twilio.ts:105-168` order: subaccount → BYO → env master) — ideally by calling the existing shared helper rather than duplicating column reads.
2. Verify the signature against the token that actually signed the request for that shop's number class.
3. Keep the existing behavior on successful verification (update delivery status in `interactions.metadata`) unchanged.
4. Add a structured log for signature-verification failures on this route (currently the failure mode is silent death).
5. Unit-test the route with a **subaccount-credentials fixture** (the missing case that let this bug ship) plus BYO and env-master fixtures.

## Explicit non-goals
- No inbound-SMS idempotency work (P0-006).
- No email delivery/bounce tracking (roadmap P7 — audit notes "email: none").
- No new delivery-status UI surfaces; existing rendering of `interactions.metadata` stands.
- No A2P registration or TrustHub work.
- No change to the send path, send policy, or metering.

## Dependencies
- None. Not blocked by P0-005/P0-006 (this is a credential-resolution bug, not an idempotency gap).

## Expected modules affected
- `src/app/api/twilio/sms/status/route.ts`
- Possibly a small export/refactor in `src/lib/twilio.ts` to share the credential-resolution helper (no behavior change to other callers)
- Tests (webhook suite already covers forgery/tamper/replay for the other routes — extend it here)

## Database impact
None. No schema change; writes remain updates to `interactions.metadata`.

## Migration impact
None.

## API impact
No contract change. The route continues to accept Twilio `StatusCallback` POSTs; the only observable difference is that subaccount-signed requests now verify and 2xx instead of failing verification.

## UI impact
None directly (existing status rendering starts receiving data for subaccount shops). No new states required.

## Permission impact
None. Route remains webhook-authenticated (Twilio signature), service-role internally.

## Tenant-isolation impact
- Shop is resolved from the message/number exactly as today; the fix must keep the interaction update scoped `.eq("shop_id", …)` on the service-role client (P0-011 discipline).
- A tenant-isolation test asserts a status callback for shop A's message cannot update shop B's interaction row.

## Security impact
- Signature verification must remain fail-closed and timing-safe for all three credential classes. The fix must not introduce a fallback that accepts an unverified request when credential lookup fails — a shop with no resolvable credentials means reject, not skip verification.

## Idempotency requirements
- Status callbacks are naturally last-write-wins on a metadata field; replaying the same callback must be harmless (same terminal status re-written). No new dedupe structure required — assert this in a test rather than assume it.

## Observability requirements
- Structured, module-prefixed log on verification failure including shop resolution outcome and credential class attempted (never log tokens or the signature value).
- Count/visibility of status-callback failures should be consumable by P0-012's alert delivery once it lands (emit through `monitoring.ts` if the seam exists by then; otherwise structured console per current convention).

## Analytics requirements
None.

## Feature flag
**None — fix.** Justification: the current behavior is a verified bug with no beneficiaries; the change is confined to one route and reversible by revert.

## Automated tests
- **Unit:** signature verification passes with a subaccount-creds fixture (request signed with subaccount token); passes with BYO fixture; passes with env-master fixture; fails closed on wrong token, tampered body, and unresolvable shop.
- **Failure-path:** credential decryption failure → reject (no unverified processing); unknown MessageSid → no write, 2xx or Twilio-appropriate response per existing convention.
- **Tenant-isolation:** callback for shop A never mutates shop B rows.
- **Replay:** same callback delivered twice → identical final state, no error.

## Manual acceptance procedure
1. On a staging shop with a Gradia-provisioned (subaccount) number, send an outbound SMS via the normal approval flow.
2. Confirm Twilio's status callback arrives and the route returns 2xx (route logs show subaccount credential class used).
3. Confirm the interaction row's metadata now carries the delivery status for that message.
4. Repeat steps 1–3 on a BYO-number staging shop — behavior unchanged from before the fix.
5. Send a forged status callback (bad signature) → verify rejection + structured log, no data change.

## Failure cases
- Shop lookup by number fails → reject with structured log (no cross-shop guessing).
- Subaccount token decryption fails (bad `ENCRYPTION_KEY` / corrupt blob) → reject, log credential-class failure loudly (this is exactly the silent mode being eliminated).
- Twilio retries after a 5xx → replay-safe per above.

## Rollback strategy
Revert the PR. No schema or data changes to unwind; worst case is returning to the current broken-but-known state for subaccount shops.

## Definition of done
Per `12-definition-of-done.md`, plus: the webhook test suite includes the subaccount fixture case (the regression that caused this bug can never ship silently again), manual acceptance evidence for both number classes recorded, and audit doc 03's "Message status / delivery" row can be flipped from BROKEN in the next audit refresh.

## Close record (docs-close session, 2026-08-25)

**Merged:** PR #23 → `main` as `1ea198f` ("fix: repair Twilio subaccount
status callbacks"), 2026-08-25; pre-squash Builder implementation `ffd6e01`
(implemented 2026-08-18 on `fix/p0-008-twilio-status-callback`).

**Review evidence:** independent Cursor verdict **APPROVE**; **no BLOCKER or
HIGH findings**. CI on the exact reviewed commit: `ci / checks` green,
`ci-integration / integration` green, Vercel Preview green.

### Final architecture (as merged)

- The status route (`src/app/api/twilio/sms/status/route.ts`) now selects
  **all six shop credential fields** and feeds them to the **existing**
  `resolveTwilioCredentials` resolver — the same subaccount → BYO →
  env-master order as the inbound webhook, exactly as this ticket required
  (no duplicated resolution logic). The resolver tags the resolved class
  (`source: "subaccount" | "byo" | "env"`) so logs can show which class
  verified. Root cause repaired: the pre-P0-008 select read only BYO
  columns, so subaccount-signed callbacks (Gradia-provisioned numbers —
  exactly the ISV class) could never verify and died silently.
- **Unknown `?shop=` no longer falls through to env-master credentials** —
  it rejects 404 with a structured log (no cross-shop credential guessing).
  The `shop` param lives inside the signed URL, so it cannot be swapped
  without breaking the signature — verified by test and acceptance.
- **Interaction lookup and update are explicitly tenant-scoped** to the
  verified shop (`.eq("shop_id", …)` on both read and write, P0-011
  discipline). A second latent bug fixed alongside the credential repair:
  the lookup had been globally unscoped, so a tenant signing with their
  OWN token could previously have mutated another tenant's row via that
  tenant's MessageSid. Now structurally impossible; proven by integration
  test and acceptance.
- **Invalid signatures fail closed** (401, structured `[twilio status]`
  rejection log with shop-resolution outcome + credential class attempted —
  never tokens or signature values). Shops with no resolvable credentials
  reject rather than skip verification.
- **BYO behavior preserved**; **legacy master/no-`?shop=` behavior
  preserved** (env-master is the only valid signer there).
- **DB lookup/update failures return retryable 500** (was 200 —
  a silently lost terminal status); Twilio's retry is safe because the
  write is last-write-wins idempotent.
- **Unknown MessageSid acknowledges 200 empty TwiML with zero writes** —
  never fabricates a row (the send-record race resolves on the next
  status transition).
- **No provider_events claim** — the callback is a naturally idempotent
  metadata write (last-write-wins), asserted by test rather than assumed,
  per this ticket's idempotency requirement. No migration. ADR-001 is not
  implicated.
- P0-006 inbound semantics unchanged. **A2P status route audited but
  unchanged** (already verifies against the subaccount token, fail-closed)
  — per the explicit non-goal; one pre-existing finding recorded as L4
  below. P0-009 not started. Production conflict enforcement remains
  **OFF**.

### Founder acceptance — PASS (isolated local staging, 2026-08-25)

Environment: isolated local staging only — local Supabase, local Next
instance, **mock Twilio REST API via the `TWILIO_API_BASE` seam**, a fresh
Gradia-subaccount shop and a fresh BYO shop, throwaway test credentials
only; zero production customer traffic; zero Production configuration
changes; production conflict enforcement OFF throughout. Evidence:

1. **Gradia subaccount:** outbound SMS passed through the real staged
   `send_sms` → `executeApproval` path; the Twilio REST request used the
   subaccount account class; the StatusCallback URL carried `?shop=`;
   signed `sent` then `delivered` callbacks each returned HTTP 200 with
   `credentialSource=subaccount`; final interaction metadata =
   `delivered` with `twilio_status_updated_at` persisted; unrelated
   metadata keys preserved through the merge.
2. **BYO:** same real approval/send path on the BYO credential class;
   signed `sent`/`delivered` callbacks returned 200 with
   `credentialSource=byo`; metadata persisted correctly — behavior
   unchanged from before the fix.
3. **Forged callbacks:** invalid signature → 401; missing signature →
   401; zero interaction mutation; no secrets logged.
4. **Tampered shop:** a signature minted for shop A's callback URL reused
   on shop B's URL → 401 — proves `?shop=` is part of the signed URL and
   cannot be swapped.
5. **Unknown MessageSid:** correctly signed callback → HTTP 200 empty
   TwiML; zero fabricated interaction; zero unrelated mutation.
6. **Unknown shop:** 404; zero credential fallback.
7. **Cross-tenant:** shop B's validly signed callback carrying shop A's
   MessageSid → acknowledged as a scoped no-op; shop A unchanged; shop B
   fabricated no row.
8. **Replay:** delivered-callback replay → HTTP 200, durable state
   unchanged (last-write-wins as designed).
9. **Reconciliation:** exactly the expected two staging interaction rows;
   zero cross-tenant writes; zero callback-created usage/financial side
   effects; zero fabricated rows.
10. **Cleanliness:** staging servers stopped; seeded acceptance data
    purged; no code modified during acceptance; no commit/push/merge
    during acceptance; no secrets exposed; production conflict
    enforcement remains OFF; P0-009 not started.

(A prior founder acceptance rehearsal on 2026-08-19 — pre-merge, local
stack, self-signed callbacks against a live `next dev` instance — covered
the same matrix plus an ErrorCode-persistence case and a bystander-shop
drift audit, with identical results.)

### Residuals and dispositions (Cursor-recorded)

- **M1 — subaccount decryption observability (follow-up filed):**
  a subaccount token decryption failure is fail-closed (correct) but the
  resolver may fall through and later log a generic signature mismatch /
  `credentialSource` env-or-none instead of explicitly reporting the
  subaccount decryption failure — the ticket's "log credential-class
  failure loudly" intent is only partially met for this specific path.
  Backlog follow-up: credential-class/decryption observability.
- **L1 — legacy no-`?shop=` global lookup (accepted LOW):** the legacy
  path authenticates against env-master and then uses a global MessageSid
  lookup. All currently generated callback URLs include `?shop=`; track
  eventual retirement of the legacy path (backlog).
- **L2 — last-write-wins / non-monotonic status (accepted by ticket):**
  explicitly permitted; a non-2xx-window retry of `sent` after
  `delivered` could regress the field. Documented residual only — no
  implementation work.
- **L3 — read-modify-write metadata merge race (accepted at pilot
  scale):** concurrent callbacks for one message could interleave the
  jsonb merge. Recorded as a scale follow-up (backlog).
- **L4 — A2P status route DB-error handling (pre-existing, out of
  scope):** the A2P status callback's shop lookup treats a DB lookup
  failure like not-found/404 rather than a retryable 500. Separate
  backlog follow-up; deliberately not changed in P0-008.

### Disposition of the P0-006-deferred findings folded in at slotting

1. *Status-callback provider_events hardening* — resolved as **not
   required**: the write is naturally idempotent last-write-wins,
   asserted by test (this ticket's stated idempotency posture).
2. *Query-string shop/token selection* — **closed**: `?shop=` is inside
   the signed URL, unknown shop rejects with no credential fallback,
   and verification proves possession of that shop's token (test-locked).
3. *Unknown-SID behavior* — **closed as correct**: signed-but-unknown
   SID acknowledges 200 with zero writes (test-locked).
4. *Stale/out-of-order status updates* — **accepted residual L2** above.
5. *A2P subaccount credential/signature verification* — **audited
   correct, unchanged**; the one finding is L4 above.

### Follow-ups recorded at close (Organizer sequences)

1. **M1** credential-class/decryption observability (backlog).
2. **L4** A2P status-callback DB-error retryability (backlog, separate
   from this ticket).
3. **L1** legacy no-`?shop=` path retirement tracking (backlog).
4. **L3** metadata-merge concurrency, if scale warrants (backlog).
5. **P0-005A** retention/pruning remains open (unchanged by this ticket —
   the status route writes no receipts).
6. Production P0-004 conflict enforcement remains **OFF**; the P0-004
   manual production-enable gate remains outstanding.

# P0-008 — Twilio subaccount status callback repair

## Ticket ID
P0-008

## Epic
E00 — Stabilization

## Status
**ready-after-P0-002** (reconciled with the index 2026-07-27) — no technical dependencies or open decisions; enters review only after P0-002 per the global review gate. (Coordinate merge order with P0-006 if both touch the Twilio webhook area, but neither blocks the other.)

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

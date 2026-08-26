# Vendor — Twilio

> **Classification:** core · **Status:** core · Amended 2026-07-27 (vendor-architecture amendment, D-030/ADR-002). Registry: ../registry.md · Domain boundary: `TelephonyProvider` (`telephony-provider.ts`, exists — preserve).

_Created 2026-07-25 by the Organizer. Vendor registry entry. Facts grounded in the 2026-07-20 audit (docs 00, 04-F, 06) and `_docs/GRADIA_TELEPHONY_VOICE_BUILDER_SPEC.md`; unverified items are marked. Runbook: `docs/twilio-go-live.md`. Tickets: P0-006, P0-008._

## Purpose
SMS send/receive and white-label business numbers. ISV subaccount model: Gradia provisions numbers in per-shop subaccounts; BYO-Twilio also supported. A2P 10DLC registration pipeline (`a2p_registrations`, `twilio-a2p.ts`). Nightly vendor reconciliation against the usage ledger.

## Data exchanged
Inbound/outbound SMS bodies + phone numbers (into `interactions` and the consent ledger), delivery status callbacks (into `interactions.metadata`), A2P business identity (legal name/EIN/address — currently plaintext jsonb, audit doc 05), per-shop subaccount SIDs/auth tokens (AES-256-GCM encrypted at rest).

## Authentication
Inbound webhooks: HMAC-SHA1 Twilio signature, timing-safe, fail-closed, per-shop credential resolution **subaccount → BYO → env master** (`twilio.ts:105-168`), test-locked by the webhook forgery suite. Outbound: per-shop creds via the same resolution order.

## Webhooks
`/api/twilio/sms` (inbound), `/api/twilio/sms/status` (delivery status), `/api/twilio/a2p/status` (registration callbacks). Shop resolved by `To` number.

## Rate limits
Carrier/API throughput limits REQUIRES VERIFICATION (Twilio console). Gradia-side: send path is metered per segment and gated by credits (fail-closed).

## Failure behavior
Signature failure → reject (fail closed). Send failures surface through the one executor (approval rolls back to pending). Inbound webhook always returns empty TwiML — no auto-reply path exists.

## Idempotency
Inbound `MessageSid` deduped via `provider_events` claim after signature verification (**P0-006, done 2026-08-14 PR #19** — retries no longer duplicate interactions, Claude calls, or approval cards). Status callbacks update metadata last-write-wins — naturally idempotent on replay (test-asserted), and as of **P0-008 (done 2026-08-25 PR #23)** they verify against the correct credential class for subaccount shops.

## Cost model
Wholesale SMS cost per segment carried on every `usage_events` row (wholesale vs retail; ~3.3× markup per pricing doc). A2P fixed cost ~$2/shop/month. Number cost folded into Package 2. Exact Twilio tariffs REQUIRES VERIFICATION (Twilio console / pricing doc worksheets).

## Monitoring
Nightly Twilio reconciliation cron compares vendor usage to the ledger; drift alerts are console-only until P0-012.

## Test environment
Webhook suite covers forgery/tamper/replay deterministically. Live SMS/A2P behavior CANNOT be verified locally (audit doc 03 CANNOT_VERIFY*). Twilio test credentials/magic numbers REQUIRES VERIFICATION (docs/twilio-go-live.md).

## Known audit gaps
- ~~**Status-callback bug:** `api/twilio/sms/status/route.ts` resolves only BYO credential columns — delivery status never records for Gradia-provisioned (subaccount) shops~~ — **closed 2026-08-25 by P0-008 (PR #23)**: full-field credential resolution (subaccount → BYO → env master), unknown `?shop=` rejects with no fallback, tenant-scoped writes, retryable 500s on DB errors. Residuals M1/L1/L2/L3/L4 in the ticket close record (M1 subaccount-decryption observability + L4 A2P DB-error retryability are backlog follow-ups).
- ~~**No inbound idempotency** on `MessageSid`~~ — **closed 2026-08-14 by P0-006 (PR #19)**.
- **A2P TrustHub policy SIDs self-declared unverified** (`twilio-a2p.ts:11-15`) — first real registration is the test (founder action, audit open question #11).
- Operator quick-reply (`sendOperatorSms`) skips send-policy (TCPA-adjacent; decision queue).
- A2P business jsonb holds EIN in plaintext (encryption warranted — E00/E10 follow-up).

## Backup or exit strategy
Telephony is behind `telephony-provider.ts` (locked principle #8) — vendor types don't leak, so a provider swap is contained work. Number portability and A2P re-registration would be the real migration cost. No exit planned.

## Owner
Founder (Harry).

# Flow — Voice Receptionist Setup

_Created 2026-07-25 by the Organizer. Grounded in audit trace H and `_docs/GRADIA_TELEPHONY_VOICE_BUILDER_SPEC.md`: self-serve builder, synthesized prompt, 8 HITL tools, go-live gate + test call. Not marketable until the live acceptance run passes (WHAT_GRADIA_DOES "not yet claimable")._

**Maturity:** EXISTS behind Package 2 entitlement — code-complete; live acceptance run outstanding (A2P TrustHub SIDs self-declared unverified, `twilio-a2p.ts:11-15`).
**Phase/Epic:** Live surface; acceptance run is a founder P0-adjacent action; refinements ride E09 (voice quote verifier).

## Entry point
`/receptionist` (progressive disclosure: the 5 things every owner sets up front, everything else behind Advanced); onboarding step 5; Package 2 upgrade moment.

## User objective
"My phone answers itself": a receptionist that quotes from the real menu, books real appointments, and never invents prices — live in minutes, no founder involvement.

## Required data
Package 2 entitlement; a number (Gradia-provisioned subaccount or BYO Twilio); A2P registration (business details) for SMS follow-ups; service menu + working hours + policies (already in the shop); voice/persona config; escalation preference.

## Exact steps
1. Owner opens the builder → the 5 up-front settings (greeting/identity, menu confirmation, hours, escalation, test).
2. Number step: provision via Twilio subaccount (encrypted creds) or BYO; voice webhook wired to the Vapi assistant automatically.
3. System synthesizes the prompt from shop data (`vapi-prompt.ts` — identity, exact menu prices via shared `service-pricing`, knowledge chunks, hours, escalation). Never hand-authored.
4. Go-live gate: required steps checked → **test call** placed by the owner; transcript + staged actions reviewed on `/calls/[callId]`.
5. Flip live → number's voice webhook active; budget guardrails armed (80% warn; 100% → take-a-message fallback; never cut a live call).
6. Every call thereafter: transcript to shared memory, minutes metered, call record idempotent on `(shop_id, vapi_call_id)`; all 8 tools stage HITL actions (booking/quote in the ALWAYS_HITL floor).

## System decisions
- Entitlement-gated: dropping Package 2 disables the receptionist next-call, never mid-call; number reserved 30 days (pricing doc).
- Prices/policies come only from the shop's own data — one pricing module across voice/quotes/drafts.
- **(P0-004)** `propose_booking` consults the conflict service and tells the caller when a slot is taken.
- **(P0-007 — live as of 2026-08-14, PR #21)** End-of-call reports deduped; voice minutes never double-metered on webhook retry.

## AI involvement
The call itself is AI (Vapi-hosted `gpt-4o-mini`), but every write it proposes is staged HITL; money/calendar ALWAYS ask. Post-call verifier (spoken-price check) is E09.

## Permissions
Owner/admin configure and flip live; (post-E01) members may review calls per role. Founder never touches per-shop setup (locked principle #9).

## Error states
- Number purchase failure → fail-closed with named cause (e.g. missing `ENCRYPTION_KEY`); builder resumable.
- A2P pending/rejected → voice can go live; SMS follow-ups stay gated with honest status copy.
- Vapi assistant drift → hourly voice-sync repairs stale assistants; budget-exceeded flips take-a-message fallback.
- Unmatched assistant webhook → rejected (VAPI_DEFAULT_SHOP_ID confirmed unset in prod — verified 2026-08-28 at the P0-010 founder acceptance; P0-007 code guard fails closed regardless).

## Empty states
- Before setup: first-use teaching state — what the receptionist does, what it will never do without approval.

## Success state
Test call passed; live badge on; first real call produces a call record with transcript, outcome, and staged follow-ups in Approvals.

## Next recommended action
Review the first calls' glass-box records; adjust knowledge/policies; consider autonomy graduation for reply drafts (never money/calendar).

## Mobile behavior
Builder usable on a phone; test call naturally mobile; call records readable with transcript collapse.

## Analytics events
`First receptionist call completed` (first live inbound call handled end-to-end).

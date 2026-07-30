# E07 — Communication Parity

_Created 2026-07-25 by the Organizer. Phase: **P7**. Status: planned._

## Objective

Make Conversations a true unified inbox: email joins voice + SMS, every thread is replyable in place, outbound email threads properly, delivery status works across channels, and a small template library serves repeated replies. Fix the email pipeline's inverted failure polarity.

## User outcome

The owner opens one inbox and sees every customer conversation — calls, texts, emails — threaded per person, replies right there (send-policy respected), sees "delivered/failed" honestly, and inserts a saved reply instead of retyping quote follow-ups.

## Business reason

"One connected system, nothing falls through the cracks" is the core claim (WHAT_GRADIA_DOES §5), but the audit shows the inbox is "voice+SMS only, read-mostly — no email channel, no in-thread reply" (doc 00). Email replies currently send as standalone messages (`aurinko.ts:356` documented gap) — visibly broken threading in the customer's mail client undercuts the professional image shops pay for.

## Current foundation

- `interactions` shared-memory table already records email alongside SMS/voice — the data is there, the Conversations UI just excludes it.
- ONE send path with policy at the boundary (`executeSendSms`/`executeSendEmail` in `approvals.ts`); `sendOperatorSms` quick reply exists (policy-skipping — the known gap).
- Aurinko client with token refresh, signature-verified webhook, replay window; SMS delivery-status route (fixed by P0-008); automation `template_overrides` + deterministic fill.

## Missing work

1. Email channel in Conversations thread list + thread view (extend the `interactions` queries; audit doc 03 "unified inbox PARTIAL").
2. In-thread reply composer: SMS via policy-checked operator send, email via staged-or-direct (decision Q-05 governs both channels' policy treatment for human operators).
3. Outbound email threading: reply with proper `In-Reply-To`/references via Aurinko (close `aurinko.ts:356-364`).
4. Inbound email idempotency (`aurinko_message_id` dedupe) if not already landed via P0-005 scope — verify, don't duplicate.
5. Flip classifier failure polarity: email classifier failure must *skip* (like SMS), not "propose lead" — an Anthropic outage must not turn every newsletter into approval cards (audit doc 04-G).
6. Email delivery/bounce tracking (Aurinko capabilities permitting — vendor doc gap to verify) + honest per-message status chips.
7. Template library: saved replies with variables, deterministic fill (reuse automation fill), insert-in-composer; template CRUD in Settings.
8. Email unsubscribe handling for marketing sends (STOP-equivalent; audit doc 03 "unsubscribe: none for email").

### Communications parity annex (added 2026-07-27 — each item owned)

| Item | Owner |
|---|---|
| Unread status (per-thread, per-member) | **Build in E07** — table stakes for an inbox |
| Search & filters (by customer, channel, outcome, date) | **Build in E07** |
| Scheduled messages ("send at 9am") | **Build in E07** — rides the staged-send path; respects quiet hours |
| MMS / attachments (inbound render + outbound send) | **Build in E07** — Twilio MMS + Aurinko attachments; metering per segment rules |
| Voicemail (missed-call recording + transcript in thread) | **Build in E07** — extends `call_records`/Vapi capture; today only a runbook mention |
| Conversation assignment (route a thread to a member) | **Build in E07, needs E01 roles** — assignment only; SLA/claiming *workflows* stay out (Non-goals) |
| Website-lead form channel (site form → thread + lead) | **Deferred → E08-era** — needs the public-surface work; owner: online-booking/public API groundwork (E02 §7) |

## Domain entities

New: `message_templates`. Modified: `interactions` (delivery-status metadata normalization across channels), thread-view accessors.

## Backend services

`aurinko.ts` (threading, bounce), Conversations data accessors, composer server actions, template module. No new engines — the one-send-path invariant holds (D-011/audit doc 09).

## UI surfaces

Conversations: channel-complete thread list, thread view with composer + channel switcher, delivery chips (icon + text, semantic tokens), template picker; Settings: template library card.

## Integrations

Aurinko (threading/bounce capabilities need live verification — record findings in `vendors/transitional/aurinko.md`), Twilio (status chips ride P0-008 fix). Note (2026-07-27): **application-generated transactional email is a separate concern** from connected-mailbox conversations (this epic) and from campaign email — no single provider is assumed to own all three; see `vendors/planned-evaluations/transactional-email.md`. No scope change here.

## Security implications

Composer respects send policy per Q-05's decision; templates render with the deterministic filler (no prompt-injection surface); email unsubscribe honored at audience + send time like SMS STOP (extends `send-policy.ts`).

## Tenant implications

Standard shop scoping; templates shop-scoped; role check on composer (E01 — techs reply only on assigned-job threads? follows Q-17 taxonomy).

## Migration implications

Additive (`message_templates`, status-metadata backfill best-effort). Low risk.

## Product analytics

No new canonical events. Sharpens `First lead received` integrity (polarity fix stops fake leads during outages).

## Dependencies

P0-005/P0-008 (idempotency + status foundations), E01 (roles on composer). Decisions: Q-05 (operator sends vs STOP/policy — founder; currently unrestricted, audit open question 6). Aurinko capability verification precedes committing to bounce tracking scope.

## Risks

- Threading correctness varies by recipient mail client — verify against Gmail/Outlook/Apple Mail before claiming it.
- Polarity flip trades false leads for potentially missed real ones during outages — mitigate with an "unclassified" review bucket instead of silent skip (design decision inside the ticket).
- Template library can drift into a campaign builder — it is a composer convenience only (campaigns stay in the agent engine).

## Non-goals

No new channels (no IG/FB DMs — locked out; no live chat widget), no email marketing builder, no per-campaign reply attribution (E09/analytics territory). **Amended 2026-07-27:** plain thread *assignment* moved into scope (parity annex — founder-required); claiming/SLA/round-robin **workflows** remain out.

## Feature flags

`FEATURES.emailInConversations`, `FEATURES.inThreadComposer`, `FEATURES.messageTemplates`.

## Testing requirements

Threading integration test (reply lands in-thread — live-verified per client matrix); polarity test (classifier failure → review bucket, zero staged lead); idempotency replay (email webhook); send-policy tests on composer per Q-05 outcome; email unsubscribe enforcement test; template fill determinism tests.

## Rollout plan

Email read-only in Conversations first (safe) → composer behind flag → threading fix live-verified → templates last. Claim "one inbox" in copy only after all four land (D-028).

## Acceptance criteria

1. A customer email appears in their unified thread; the owner replies in place; the reply threads correctly in the customer's mail client.
2. Simulated classifier outage produces zero fabricated lead cards; items land in a visible review bucket.
3. Delivery status renders honestly for SMS and email (or explicitly "unknown" where the provider can't say).
4. A saved template inserts, fills variables deterministically, and passes send policy.
5. Email unsubscribe suppresses marketing sends at audience and send time.

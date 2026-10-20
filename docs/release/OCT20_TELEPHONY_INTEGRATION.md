# October 20 telephony integration review

Scope: PR96 auth plus PR97/98/99/100 combined on current main. Experimental
employee branches are excluded. This is a private-review candidate, not provider
activation approval. Public promotion, write unfreeze, providers and crons remain
separate release decisions.

## Auth and browser evidence

PR96 accepts only an operator-configured HTTP(S) localhost/127.0.0.1 origin off
Vercel, rejects URL credentials, and never derives redirect authority from request
headers. Vercel and explicitly configured private-review origins retain their
existing checks. Internal-next sanitization is unchanged. Its draft may be lifted
after the combined auth regressions pass.

Cursor reports signed-in disposable acceptance at 6cbcc50909add7bde451ffab8fdef1f517b3de45:
owner save/resume/skip, rejected registration refusal, BYO confirm/withdraw,
failed reads, manager and revoked access, keyboard, 320/390px and browser 200% zoom.
These are Cursor's supplied results, not a new hosted acceptance run by Codex.
Recording: https://cursor.com/agents/bc-87cb04a6-4e28-49f4-8183-0e48938c4757/artifacts?path=%2Fopt%2Fcursor%2Fartifacts%2Fonboarding-integrated-acceptance.mp4

## Combined review findings and activation holds

- Registration claims serialize attempts within the 15-minute lease; checkpoints
  and final status writes require the matching token. Final registration and shop
  statuses share a transaction. Expiry allows takeover, but cannot undo a provider
  call already in flight. The claim does not alone prove external exactly-once
  behavior. Partial profile/brand/messaging-service creation still needs durable
  uncertain-outcome reconciliation. Do not advertise complete retry safety.
- Campaign listing/adoption prevents the tested lost campaign-create response
  from blindly creating another campaign. It does not cover all preceding
  resource-creation stages or all ambiguous/multiple-resource responses.
- Number purchase uses list-before-buy and conditional persistence, then releases
  a losing duplicate. This is compensation, not a provider-call single-flight
  lock. Two requests can still buy distinct numbers; release failure leaves a
  resource requiring reconciliation. Adoption does not itself verify every
  webhook/routing setting. These remain live-purchase acceptance blockers.
- Number ownership now validates BYO account inventory, narrows pilot fallback to
  an explicit shop/number allowlist, and guards direct active-number writes.
  No pilot allowlist entry is added by this release. Existing-row effects must be
  reviewed from the read-only preflight, never silently repaired.
- Delivery callback status advances conditionally; conflicting terminal outcomes
  are stored in metadata and logged. No product reader of
  `twilio_status_conflict` currently exists. Thus persisted conflict evidence is
  not operator-visible resolution. The status-only CAS also does not protect
  unrelated metadata edits. Callback-before-interaction remains a known gap.
- Approved campaigns are rechecked when sync runs, and known suspension closes
  the gate atomically. No scheduler is activated. A provider outage preserves
  prior approval; stale approval has no expiry here. Claude's separate freshness
  and reconciliation work is required before live texting activation.

These findings do not justify enabling customer traffic. The private UI candidate
keeps the existing database freeze and team authentication restrictions.

## Migration gate

From the 98-migration baseline, apply only these three in timestamp order:
20261019120000_a2p_registration_claim.sql,
20261019130000_shops_twilio_phone_number_server_written.sql,
20261019140000_a2p_campaign_suspended.sql.
They alter existing tables/functions/constraints and add no public table. Preserve
all 63 existing ALWAYS write-freeze triggers and RLS. Verify unique versions,
upgrade from baseline, RPC grants and the read-only number-ownership preflight.

## Required validation

Final combined main-targeted CI must pass unit, types, lint, production build and
the full database integration suite. No local baseline/flakiness exemption.
Execution results and exact released commit are recorded with private release
evidence; this document records review scope and remaining limits.

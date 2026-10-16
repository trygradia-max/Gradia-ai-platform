# Channel provider accounts and readiness

The backend contracts for the provider accounts behind Gradia's customer channels.
This document describes code, not activation: providers, crons and live sends stay
held until the release lane accepts each channel.

## One Twilio subaccount per business

October 15, 2026. Migration 96 and `ensureSubaccount` in
`src/lib/telephony-provider.ts`.

Each business that buys a Gradia number gets exactly one Twilio subaccount, and a
subaccount belongs to exactly one business.

- **When it's created:** on the first number purchase, never at signup or number
  search. The subaccount's FriendlyName is the shop id.
- **A stored SID is never replaced.** If its token no longer decrypts, for
  example after key rotation, the token is fetched again from Twilio for the same
  SID. That only happens if the subaccount is active and named for this shop.
  Otherwise the purchase stops with "needs attention", and no new subaccount is
  created, so the shop's number is never stranded.
- **Orphans are adopted.** If Twilio created a subaccount but Gradia failed to
  save it, the next attempt finds it by name and adopts it. Two active
  subaccounts named for one shop stop the purchase for reconciliation; nothing
  more is created.
- **Concurrent purchases.** The SID is saved only if none is stored. The first
  save wins. Every other attempt closes the duplicate it just created, which has
  no numbers yet, and returns the winner's credentials.
- **One shop per subaccount.** The partial unique index
  `shops_twilio_subaccount_sid_unique` refuses the same SID on two shops.
- **Not changed:** number purchase (still one number per shop), release
  (subaccounts are not closed when a number is released), BYO credentials and
  credential resolution.

Verified by `eval/integration/twilio-subaccount.int.test.ts` against a fake Twilio
Accounts API.

**Release note:** migration 96 fails, changing nothing, if two shops already share
a SID. Reconcile those shops first.

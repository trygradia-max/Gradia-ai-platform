BEGIN;
-- One shop per Twilio subaccount. ensureSubaccount (telephony-provider.ts) keeps
-- one subaccount per shop by never replacing a stored SID; this index makes the
-- other direction a database guarantee, so a mistaken adoption or copy can never
-- give two businesses the same account, numbers and A2P registration.
--
-- Release note: if any two shops already share a SID this fails with the
-- duplicate value, and nothing changes. Reconcile those shops first; do not
-- drop the index to proceed.
CREATE UNIQUE INDEX shops_twilio_subaccount_sid_unique
  ON public.shops (twilio_subaccount_sid)
  WHERE twilio_subaccount_sid IS NOT NULL;
COMMIT;

-- BYO Twilio per shop. Until now the pilot used one global Twilio
-- account in env vars and each shop just stored the number it owned
-- on it. That doesn't scale past a handful of shops — deliverability
-- on one shop's traffic affects every other shop, and A2P 10DLC
-- registrations are per-account.
--
-- New columns let each shop drop in their own Account SID + Auth
-- Token (encrypted at rest). When set, lib/twilio.ts uses them for
-- send + signature verification; when null, it falls back to the
-- env globals so existing pilots keep working.
-- Idempotent.

ALTER TABLE public.shops
  ADD COLUMN IF NOT EXISTS twilio_account_sid_enc text,
  ADD COLUMN IF NOT EXISTS twilio_auth_token_enc text;

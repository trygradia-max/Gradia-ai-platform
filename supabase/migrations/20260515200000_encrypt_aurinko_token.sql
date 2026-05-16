-- Move the one piece of real credential material we store
-- (shops.aurinko_access_token) from plaintext to an application-
-- encrypted column. Vapi/Twilio/Stripe rows hold non-credential
-- identifiers (assistant id, phone, acct_XXX) and stay plaintext.
--
-- Encryption is AES-256-GCM at the app layer (src/lib/crypto.ts)
-- using ENCRYPTION_KEY from env. The DB only sees opaque base64.
--
-- Migration is destructive of any existing plaintext token —
-- pilot operators have to Disconnect + Reconnect in /settings once
-- after deploy. Account ID and subscription ID are preserved so the
-- UI still shows them as "connected" pre-reconnect, surfacing the
-- failed API calls as a clear cue to reauth.

ALTER TABLE public.shops
  ADD COLUMN IF NOT EXISTS aurinko_access_token_enc text;

ALTER TABLE public.shops
  DROP COLUMN IF EXISTS aurinko_access_token;

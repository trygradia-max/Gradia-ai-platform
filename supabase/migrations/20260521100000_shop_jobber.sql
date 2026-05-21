-- Jobber CRM integration. Detailers using Jobber for invoicing +
-- scheduling don't want to abandon it — Gradia sits on top by
-- pushing approved leads/bookings into their Jobber account.
--
-- OAuth2 (authorization code) with refresh tokens; both stored
-- encrypted at rest via lib/crypto.ts. We also keep the account id
-- + display name for the settings card. Idempotent.

ALTER TABLE public.shops
  ADD COLUMN IF NOT EXISTS jobber_account_id text,
  ADD COLUMN IF NOT EXISTS jobber_account_name text,
  ADD COLUMN IF NOT EXISTS jobber_access_token_enc text,
  ADD COLUMN IF NOT EXISTS jobber_refresh_token_enc text,
  ADD COLUMN IF NOT EXISTS jobber_token_expires_at timestamptz;

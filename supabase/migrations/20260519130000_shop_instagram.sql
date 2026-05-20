-- Instagram DM (Meta Messenger Platform) connection per shop.
-- Pilot OAuth model is manual: the operator pastes their IG Business
-- Account ID + Page Access Token after going through Meta's
-- developer dashboard. The token is encrypted at rest with the same
-- AES-256-GCM helper as Aurinko.
--
-- `instagram_page_id` is the Facebook Page ID the IG Business
-- Account is linked to — Meta's webhook payload identifies events
-- by Page ID, not IG Account ID, so we route on that.
-- Idempotent.

ALTER TABLE public.shops
  ADD COLUMN IF NOT EXISTS instagram_business_account_id text,
  ADD COLUMN IF NOT EXISTS instagram_page_id text,
  ADD COLUMN IF NOT EXISTS instagram_page_access_token_enc text,
  ADD COLUMN IF NOT EXISTS instagram_account_handle text;

CREATE UNIQUE INDEX IF NOT EXISTS shops_instagram_page_id_unique
  ON public.shops (instagram_page_id)
  WHERE instagram_page_id IS NOT NULL;

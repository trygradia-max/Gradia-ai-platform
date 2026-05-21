-- Outbound Facebook Page DMs. Mirrors the Instagram chunk:
--   - send_facebook_dm pending_action_type
--   - shops gains facebook_page_id + encrypted page access token + display name
-- Idempotent.

ALTER TYPE public.pending_action_type ADD VALUE IF NOT EXISTS 'send_facebook_dm';

ALTER TABLE public.shops
  ADD COLUMN IF NOT EXISTS facebook_page_id text,
  ADD COLUMN IF NOT EXISTS facebook_page_access_token_enc text,
  ADD COLUMN IF NOT EXISTS facebook_page_name text;

-- Same shape as the IG page id index — one shop per page.
CREATE UNIQUE INDEX IF NOT EXISTS shops_facebook_page_id_unique
  ON public.shops (facebook_page_id)
  WHERE facebook_page_id IS NOT NULL;

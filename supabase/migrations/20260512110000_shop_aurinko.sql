-- Aurinko email connection per shop. Plain-text token storage is a known
-- pilot-stage limitation — the multi-tenant secrets infrastructure
-- (encrypted per-shop OAuth tokens with refresh) is queued as its own
-- body of work. Idempotent.

ALTER TABLE public.shops
  ADD COLUMN IF NOT EXISTS aurinko_account_id bigint,
  ADD COLUMN IF NOT EXISTS aurinko_account_email text,
  ADD COLUMN IF NOT EXISTS aurinko_access_token text,
  ADD COLUMN IF NOT EXISTS aurinko_subscription_id text;

CREATE UNIQUE INDEX IF NOT EXISTS shops_aurinko_account_id_unique
  ON public.shops (aurinko_account_id)
  WHERE aurinko_account_id IS NOT NULL;

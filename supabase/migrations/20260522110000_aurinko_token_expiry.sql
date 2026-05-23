-- Track when each shop's Aurinko access token nominally expires, so
-- lib/aurinko.ts can refresh transparently instead of forcing the
-- operator to disconnect + reconnect.
--
-- Tokens are very long-lived in practice (often weeks/months) but
-- they do expire. NULL means "we don't know yet" — refresh logic
-- treats unknown expiry as not-yet-stale.
-- Idempotent.

ALTER TABLE public.shops
  ADD COLUMN IF NOT EXISTS aurinko_token_expires_at timestamptz;

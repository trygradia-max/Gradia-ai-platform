-- Per-shop Vapi routing: each shop pastes their Vapi assistant ID in
-- /settings, and the webhook resolves the shop by matching the assistant
-- ID on the inbound call. Replaces single-shop VAPI_DEFAULT_SHOP_ID mode.
-- Idempotent.

ALTER TABLE public.shops
  ADD COLUMN IF NOT EXISTS vapi_assistant_id text;

-- Partial unique index: an assistant can only belong to one shop, but
-- many shops may have NULL while they're not yet wired up to voice.
CREATE UNIQUE INDEX IF NOT EXISTS shops_vapi_assistant_id_unique
  ON public.shops (vapi_assistant_id)
  WHERE vapi_assistant_id IS NOT NULL;

-- Fifth pending_action_type: charge_customer. On approval the engine
-- creates a Stripe Invoice on the shop's connected account; Stripe
-- emails the customer a hosted-payment link. No card on file required.
--
-- Stripe Connect Standard accounts: shops own their Stripe account,
-- our platform key + the connected account id are all we store. Never
-- a per-shop secret key.
-- Idempotent.

ALTER TYPE public.pending_action_type ADD VALUE IF NOT EXISTS 'charge_customer';

ALTER TABLE public.shops
  ADD COLUMN IF NOT EXISTS stripe_account_id text,
  ADD COLUMN IF NOT EXISTS stripe_charges_enabled boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS shops_stripe_account_id_unique
  ON public.shops (stripe_account_id)
  WHERE stripe_account_id IS NOT NULL;

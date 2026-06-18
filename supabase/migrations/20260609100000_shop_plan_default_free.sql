-- Phase 3 go-live: new signups start on the free plan.
--
-- 20260601100000_credits_billing.sql added `plan` with DEFAULT 'active' so
-- existing pilot shops were grandfathered and flipping the paywall flag could
-- never lock them out. That default also meant every NEW signup bypassed the
-- paywall forever — the documented go-live gap.
--
-- Changing only the column DEFAULT touches no existing row: grandfathered
-- shops stay 'active'; shops created after this migration start 'free' and
-- are gated to /billing until Stripe Checkout activates them. Idempotent.

ALTER TABLE public.shops ALTER COLUMN plan SET DEFAULT 'free';

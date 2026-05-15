-- Twilio SMS connection per shop. Pilot scope: one global Twilio
-- account (credentials in env), each shop owns one phone number on
-- that account. Avoids the multi-tenant secrets work — no per-shop
-- auth tokens stored. Idempotent.

ALTER TABLE public.shops
  ADD COLUMN IF NOT EXISTS twilio_phone_number text;

-- Phone numbers are stored in E.164 (e.g., +15551234567). Partial
-- unique index keeps two shops from claiming the same Twilio number.
CREATE UNIQUE INDEX IF NOT EXISTS shops_twilio_phone_number_unique
  ON public.shops (twilio_phone_number)
  WHERE twilio_phone_number IS NOT NULL;

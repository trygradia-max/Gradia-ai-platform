-- Shop contact metadata used by the onboarding wizard. Both nullable so
-- existing rows survive; the wizard fills them in on first sign-up.

ALTER TABLE public.shops
  ADD COLUMN IF NOT EXISTS location text,
  ADD COLUMN IF NOT EXISTS phone text;

-- Housecall Pro CRM integration. A second CRM behind the same
-- provider seam as Jobber (lib/crm-provider.ts): detailers running on
-- Housecall Pro keep it as their system of record while Gradia pushes
-- approved leads/bookings into it.
--
-- OAuth2 (authorization code) with refresh tokens; both stored
-- encrypted at rest via lib/crypto.ts. We also keep the account id
-- + display name for the settings card. Mirrors the Jobber column
-- layout exactly so the seam stays symmetric. Idempotent.

ALTER TABLE public.shops
  ADD COLUMN IF NOT EXISTS housecallpro_account_id text,
  ADD COLUMN IF NOT EXISTS housecallpro_account_name text,
  ADD COLUMN IF NOT EXISTS housecallpro_access_token_enc text,
  ADD COLUMN IF NOT EXISTS housecallpro_refresh_token_enc text,
  ADD COLUMN IF NOT EXISTS housecallpro_token_expires_at timestamptz;

-- Mirror the Housecall-side ids we create on approval, parallel to the
-- jobber_client_id / jobber_request_id columns. One customer ↔ one HCP
-- customer; one approved booking ↔ one HCP job.
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS housecallpro_customer_id text;

CREATE INDEX IF NOT EXISTS customers_housecallpro_customer_id_idx
  ON public.customers (housecallpro_customer_id)
  WHERE housecallpro_customer_id IS NOT NULL;

ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS housecallpro_job_id text;

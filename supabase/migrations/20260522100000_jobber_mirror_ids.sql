-- Mirror the Jobber-side IDs we create when pushing on approval, so
-- the customer detail page can render "Synced to Jobber" badges and
-- (in a future pass) deep-link to the Jobber UI.
--
-- jobber_client_id lives on customers (one shop's customer ↔ one
-- Jobber client). jobber_request_id lives on appointments (one
-- approved booking ↔ one Jobber intake request).
-- Idempotent.

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS jobber_client_id text;

CREATE INDEX IF NOT EXISTS customers_jobber_client_id_idx
  ON public.customers (jobber_client_id)
  WHERE jobber_client_id IS NOT NULL;

ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS jobber_request_id text;

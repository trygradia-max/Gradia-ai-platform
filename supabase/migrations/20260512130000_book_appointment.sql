-- Third pending_action_type: book_appointment. When approved, the
-- engine creates a calendar event via Aurinko and lands an appointment
-- row linked back to the lead + the external calendar event id.
-- Idempotent.

ALTER TYPE public.pending_action_type ADD VALUE IF NOT EXISTS 'book_appointment';

ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES public.customers (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS duration_minutes integer,
  ADD COLUMN IF NOT EXISTS service_name text,
  ADD COLUMN IF NOT EXISTS aurinko_calendar_id text,
  ADD COLUMN IF NOT EXISTS aurinko_event_id text;

CREATE UNIQUE INDEX IF NOT EXISTS appointments_aurinko_event_id_unique
  ON public.appointments (aurinko_event_id)
  WHERE aurinko_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS appointments_customer_id_idx
  ON public.appointments (customer_id);

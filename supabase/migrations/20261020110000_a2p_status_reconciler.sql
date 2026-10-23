BEGIN;
-- Held A2P status reconciler (October 20 brief, priority 2). Additive.
--   next_check_at   when the reconciler should check this registration next;
--                   NULL means as soon as possible (existing rows: due now)
--   check_failures  consecutive failed checks, for exponential backoff
-- The reconciler (src/lib/a2p-reconciler.ts) is off unless
-- A2P_RECONCILER_ENABLED=true and isn't scheduled anywhere; these columns do
-- nothing until the release lane turns it on.
ALTER TABLE public.a2p_registrations
  ADD COLUMN next_check_at timestamptz,
  ADD COLUMN check_failures integer NOT NULL DEFAULT 0 CHECK (check_failures >= 0);

CREATE INDEX a2p_registrations_due_idx ON public.a2p_registrations (next_check_at NULLS FIRST)
  WHERE status IN ('brand_pending', 'campaign_pending', 'approved', 'suspended');
COMMIT;

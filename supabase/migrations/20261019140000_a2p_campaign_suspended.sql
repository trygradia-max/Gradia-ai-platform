BEGIN;
-- A2P campaign suspension (Twilio review of October 19, findings R4 and R7).
-- Carriers can suspend a campaign after approval. The registration becomes
-- 'suspended' and shops.a2p_status 'suspended', which closes the send gate
-- (only 'approved' opens it). Status checks keep re-reading the campaign and
-- reopen it only when Twilio reports VERIFIED again.
-- Both statuses are written together by a2p_finish_registration
-- (migration 20261019120000). Constraint widening only; no data rewritten.
ALTER TABLE public.a2p_registrations DROP CONSTRAINT a2p_registrations_status_check;
ALTER TABLE public.a2p_registrations ADD CONSTRAINT a2p_registrations_status_check
  CHECK (status IN ('draft', 'brand_pending', 'campaign_pending', 'approved', 'rejected', 'suspended'));

ALTER TABLE public.shops DROP CONSTRAINT shops_a2p_status_check;
ALTER TABLE public.shops ADD CONSTRAINT shops_a2p_status_check
  CHECK (a2p_status IN ('unregistered', 'pending', 'approved', 'rejected', 'suspended'));
COMMIT;

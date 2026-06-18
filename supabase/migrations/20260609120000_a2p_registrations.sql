-- A2P 10DLC registration state (TELEPHONY_VOICE_BUILDER_SPEC §1.3).
--
-- One row per shop tracking the carrier-compliance pipeline for its
-- Gradia-provisioned number:
--
--   draft → brand_pending → campaign_pending → approved
--                       ↘ rejected (with actionable failure_reason)
--
-- The pipeline stages map to TrustHub/Messaging resources whose SIDs are
-- recorded as they're created (secondary customer profile + A2P trust
-- product → brand → messaging service → campaign → number attach).
-- Rejections are common (mismatched name vs EIN, vague samples) — the row
-- keeps the submitted business details so the owner can fix and resubmit
-- in place.
--
-- shops.a2p_status stays the cheap read for the send-boundary gate;
-- syncA2pStatus mirrors the pipeline outcome into it. Idempotent.

CREATE TABLE IF NOT EXISTS public.a2p_registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL UNIQUE REFERENCES public.shops (id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'brand_pending', 'campaign_pending', 'approved', 'rejected')),
  -- Owner-submitted business details (legal name, EIN, address, contact…).
  -- Kept verbatim for resubmission after a rejection.
  business jsonb NOT NULL DEFAULT '{}'::jsonb,
  customer_profile_sid text,   -- BU… secondary customer profile bundle
  trust_product_sid text,      -- BU… A2P messaging trust product bundle
  brand_sid text,              -- BN… brand registration
  messaging_service_sid text,  -- MG… messaging service the number attaches to
  campaign_sid text,           -- QE… UsA2p campaign
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.a2p_registrations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS a2p_registrations_tenant_isolation ON public.a2p_registrations;
CREATE POLICY a2p_registrations_tenant_isolation ON public.a2p_registrations
  FOR ALL USING (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  )
  WITH CHECK (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  );

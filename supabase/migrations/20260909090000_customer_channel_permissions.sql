-- No legacy consent is inferred, copied, or repaired. Missing marketing
-- permission fails closed; destination changes require fresh permission.
CREATE TABLE public.customer_channel_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('sms', 'email')),
  destination text NOT NULL CHECK (length(destination) > 0),
  suppressed_at timestamptz,
  marketing_consent_at timestamptz,
  consent_source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, customer_id, channel, destination),
  CHECK (marketing_consent_at IS NULL OR nullif(trim(consent_source), '') IS NOT NULL)
);
ALTER TABLE public.customer_channel_permissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY customer_channel_permissions_owner ON public.customer_channel_permissions
  FOR ALL TO authenticated
  USING (shop_id IN (SELECT id FROM public.shops WHERE owner_id = auth.uid()))
  WITH CHECK (shop_id IN (SELECT id FROM public.shops WHERE owner_id = auth.uid()));

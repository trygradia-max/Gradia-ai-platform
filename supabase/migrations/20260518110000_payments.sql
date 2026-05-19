-- Local mirror of paid Stripe invoices so BI chat + dashboards can
-- answer money questions without round-tripping to Stripe on every
-- query. Populated from the existing invoice.paid webhook handler
-- (/api/stripe/webhook).
--
-- One row per paid invoice. Unique on stripe_invoice_id within a shop
-- so Stripe's webhook retries can't insert duplicates. RLS scoped per
-- shop, same pattern as every other tenant-isolated table.
-- Idempotent.

CREATE TABLE IF NOT EXISTS public.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops (id) ON DELETE CASCADE,
  customer_id uuid REFERENCES public.customers (id) ON DELETE SET NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  currency text NOT NULL DEFAULT 'usd',
  description text,
  stripe_account_id text,
  stripe_invoice_id text NOT NULL,
  stripe_invoice_number text,
  hosted_invoice_url text,
  paid_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS payments_shop_invoice_unique
  ON public.payments (shop_id, stripe_invoice_id);

CREATE INDEX IF NOT EXISTS payments_shop_paid_at_idx
  ON public.payments (shop_id, paid_at DESC);

CREATE INDEX IF NOT EXISTS payments_customer_id_idx
  ON public.payments (customer_id);

ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payments_tenant_isolation ON public.payments;
CREATE POLICY payments_tenant_isolation ON public.payments
  FOR ALL USING (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  )
  WITH CHECK (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  );

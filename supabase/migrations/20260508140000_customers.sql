-- Unified customer identity. One row per real-world person, per shop —
-- linked across phone, email, Instagram, Facebook so the agentic brain can
-- recognize the same customer no matter which channel they reach us through.

CREATE TABLE public.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops (id) ON DELETE CASCADE,
  name text,
  phone text,
  email text,
  instagram_handle text,
  facebook_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX customers_shop_id_idx ON public.customers (shop_id);

-- Partial unique indexes — one identifier per channel per shop. NULLs are
-- ignored, so a customer with only a phone doesn't block another with only
-- an email. These are the database-level safety net behind
-- find_or_create_customer; even if app code is bypassed, duplicates can't
-- be inserted.
CREATE UNIQUE INDEX customers_shop_phone_unique
  ON public.customers (shop_id, phone)
  WHERE phone IS NOT NULL;

CREATE UNIQUE INDEX customers_shop_email_unique
  ON public.customers (shop_id, email)
  WHERE email IS NOT NULL;

CREATE UNIQUE INDEX customers_shop_instagram_unique
  ON public.customers (shop_id, instagram_handle)
  WHERE instagram_handle IS NOT NULL;

CREATE UNIQUE INDEX customers_shop_facebook_unique
  ON public.customers (shop_id, facebook_id)
  WHERE facebook_id IS NOT NULL;

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

CREATE POLICY customers_tenant_isolation ON public.customers
  FOR ALL USING (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  )
  WITH CHECK (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  );

-- Link leads to customers. Nullable so legacy rows survive; new rows always
-- get one via find_or_create_customer in the approval flow.
ALTER TABLE public.leads
  ADD COLUMN customer_id uuid REFERENCES public.customers (id) ON DELETE SET NULL;

CREATE INDEX leads_customer_id_idx ON public.leads (customer_id);

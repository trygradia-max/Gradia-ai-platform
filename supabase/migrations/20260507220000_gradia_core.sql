-- Gradia core schema: multi-tenant tables with RLS scoped to shop ownership.
-- Idempotent — safe to re-run against a database that already has parts applied.

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.lead_status AS ENUM ('new', 'quoted', 'booked');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.shops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  owner_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shops_owner_id_idx ON public.shops (owner_id);

CREATE TABLE IF NOT EXISTS public.services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops (id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  duration_minutes integer NOT NULL CHECK (duration_minutes > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS services_shop_id_idx ON public.services (shop_id);

CREATE TABLE IF NOT EXISTS public.leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops (id) ON DELETE CASCADE,
  customer_name text NOT NULL,
  phone text NOT NULL,
  car_info text,
  pin_notes text,
  status public.lead_status NOT NULL DEFAULT 'new',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS leads_shop_id_idx ON public.leads (shop_id);
CREATE INDEX IF NOT EXISTS leads_status_idx ON public.leads (status);

CREATE TABLE IF NOT EXISTS public.appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops (id) ON DELETE CASCADE,
  lead_id uuid REFERENCES public.leads (id) ON DELETE SET NULL,
  scheduled_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS appointments_shop_id_idx ON public.appointments (shop_id);
CREATE INDEX IF NOT EXISTS appointments_lead_id_idx ON public.appointments (lead_id);
CREATE INDEX IF NOT EXISTS appointments_scheduled_at_idx ON public.appointments (scheduled_at);

-- -----------------------------------------------------------------------------
-- Row Level Security (ALTER ... ENABLE is idempotent on its own)
-- -----------------------------------------------------------------------------
ALTER TABLE public.shops ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.services ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appointments ENABLE ROW LEVEL SECURITY;

-- Shops: full access only for the owning user.
DROP POLICY IF EXISTS shops_select_own ON public.shops;
CREATE POLICY shops_select_own ON public.shops
  FOR SELECT USING (owner_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS shops_insert_own ON public.shops;
CREATE POLICY shops_insert_own ON public.shops
  FOR INSERT WITH CHECK (owner_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS shops_update_own ON public.shops;
CREATE POLICY shops_update_own ON public.shops
  FOR UPDATE USING (owner_id = (SELECT auth.uid()))
  WITH CHECK (owner_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS shops_delete_own ON public.shops;
CREATE POLICY shops_delete_own ON public.shops
  FOR DELETE USING (owner_id = (SELECT auth.uid()));

-- Tenant isolation: any row tied to a shop is visible only to that shop's owner.
DROP POLICY IF EXISTS services_tenant_isolation ON public.services;
CREATE POLICY services_tenant_isolation ON public.services
  FOR ALL USING (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  )
  WITH CHECK (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  );

DROP POLICY IF EXISTS leads_tenant_isolation ON public.leads;
CREATE POLICY leads_tenant_isolation ON public.leads
  FOR ALL USING (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  )
  WITH CHECK (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  );

DROP POLICY IF EXISTS appointments_tenant_isolation ON public.appointments;
CREATE POLICY appointments_tenant_isolation ON public.appointments
  FOR ALL USING (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  )
  WITH CHECK (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  );

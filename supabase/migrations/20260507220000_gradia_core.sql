-- Gradia core schema: multi-tenant tables with RLS scoped to shop ownership.

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------
CREATE TYPE public.lead_status AS ENUM ('new', 'quoted', 'booked');

-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------
CREATE TABLE public.shops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  owner_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX shops_owner_id_idx ON public.shops (owner_id);

CREATE TABLE public.services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops (id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  duration_minutes integer NOT NULL CHECK (duration_minutes > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX services_shop_id_idx ON public.services (shop_id);

CREATE TABLE public.leads (
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

CREATE INDEX leads_shop_id_idx ON public.leads (shop_id);
CREATE INDEX leads_status_idx ON public.leads (status);

CREATE TABLE public.appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops (id) ON DELETE CASCADE,
  lead_id uuid REFERENCES public.leads (id) ON DELETE SET NULL,
  scheduled_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX appointments_shop_id_idx ON public.appointments (shop_id);
CREATE INDEX appointments_lead_id_idx ON public.appointments (lead_id);
CREATE INDEX appointments_scheduled_at_idx ON public.appointments (scheduled_at);

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------
ALTER TABLE public.shops ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.services ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appointments ENABLE ROW LEVEL SECURITY;

-- Shops: full access only for the owning user.
CREATE POLICY shops_select_own ON public.shops
  FOR SELECT USING (owner_id = (SELECT auth.uid()));

CREATE POLICY shops_insert_own ON public.shops
  FOR INSERT WITH CHECK (owner_id = (SELECT auth.uid()));

CREATE POLICY shops_update_own ON public.shops
  FOR UPDATE USING (owner_id = (SELECT auth.uid()))
  WITH CHECK (owner_id = (SELECT auth.uid()));

CREATE POLICY shops_delete_own ON public.shops
  FOR DELETE USING (owner_id = (SELECT auth.uid()));

-- Tenant isolation: any row tied to a shop is visible only to that shop's owner.
CREATE POLICY services_tenant_isolation ON public.services
  FOR ALL USING (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  )
  WITH CHECK (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  );

CREATE POLICY leads_tenant_isolation ON public.leads
  FOR ALL USING (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  )
  WITH CHECK (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  );

CREATE POLICY appointments_tenant_isolation ON public.appointments
  FOR ALL USING (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  )
  WITH CHECK (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  );

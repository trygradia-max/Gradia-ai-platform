-- Shared memory layer: every customer touchpoint across voice, SMS, email,
-- and social lands here as one row, with an embedding so the AI can recall
-- relevant context regardless of which channel it came in on.
-- Idempotent — safe to re-run.

CREATE EXTENSION IF NOT EXISTS vector;

DO $$ BEGIN
  CREATE TYPE public.interaction_channel AS ENUM (
    'voice',
    'sms',
    'email',
    'instagram',
    'facebook',
    'web',
    'note'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE public.interaction_role AS ENUM (
    'customer',
    'gradia',
    'system'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS public.interactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops (id) ON DELETE CASCADE,
  customer_id uuid REFERENCES public.customers (id) ON DELETE CASCADE,
  channel public.interaction_channel NOT NULL,
  role public.interaction_role NOT NULL,
  content text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  embedding vector(1536),
  embedding_model text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS interactions_shop_id_idx
  ON public.interactions (shop_id);

CREATE INDEX IF NOT EXISTS interactions_customer_id_idx
  ON public.interactions (customer_id);

CREATE INDEX IF NOT EXISTS interactions_occurred_at_idx
  ON public.interactions (occurred_at DESC);

-- HNSW index for cosine-similarity nearest-neighbor search.
-- Defaults (m=16, ef_construction=64) are fine for our scale.
CREATE INDEX IF NOT EXISTS interactions_embedding_cosine_idx
  ON public.interactions
  USING hnsw (embedding vector_cosine_ops);

ALTER TABLE public.interactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS interactions_tenant_isolation ON public.interactions;
CREATE POLICY interactions_tenant_isolation ON public.interactions
  FOR ALL USING (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  )
  WITH CHECK (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  );

-- Vector similarity search RPC. Caller passes shop_id explicitly (the
-- service-role agent backend bypasses RLS but is responsible for tenant
-- scoping). User-session callers also work — RLS will already restrict the
-- shop_ids they can see.
CREATE OR REPLACE FUNCTION public.match_customer_memory(
  p_shop_id uuid,
  p_customer_id uuid,
  p_query_embedding vector(1536),
  p_match_count int DEFAULT 6,
  p_min_similarity real DEFAULT 0.5
)
RETURNS TABLE (
  id uuid,
  customer_id uuid,
  channel public.interaction_channel,
  role public.interaction_role,
  content text,
  metadata jsonb,
  occurred_at timestamptz,
  similarity real
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    i.id,
    i.customer_id,
    i.channel,
    i.role,
    i.content,
    i.metadata,
    i.occurred_at,
    (1 - (i.embedding <=> p_query_embedding))::real AS similarity
  FROM public.interactions i
  WHERE i.shop_id = p_shop_id
    AND (p_customer_id IS NULL OR i.customer_id = p_customer_id)
    AND i.embedding IS NOT NULL
    AND (1 - (i.embedding <=> p_query_embedding)) >= p_min_similarity
  ORDER BY i.embedding <=> p_query_embedding ASC
  LIMIT p_match_count;
$$;

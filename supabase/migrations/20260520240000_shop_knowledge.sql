-- Shop-level knowledge base for RAG: FAQs, brand voice notes, policies,
-- services we DON'T offer, hours, deposit rules, weather cancellation
-- language — anything the owner wants drafters and the BI chat to
-- ground their answers in.
--
-- Each row is one entry (we don't auto-chunk in v1; the owner can paste
-- one fact / policy / paragraph per entry). pgvector cosine matches via
-- match_shop_knowledge RPC. Same embedding model as interactions
-- (text-embedding-3-small, 1536 dims) so we can reuse the same lib.
-- RLS scoped per shop_id. Idempotent.

CREATE TABLE IF NOT EXISTS public.shop_knowledge (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops (id) ON DELETE CASCADE,
  source_name text NOT NULL,
  content text NOT NULL CHECK (length(content) > 0),
  embedding vector(1536),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shop_knowledge_shop_id_idx
  ON public.shop_knowledge (shop_id, created_at DESC);

-- HNSW cosine index — mirrors the interactions table for consistency.
CREATE INDEX IF NOT EXISTS shop_knowledge_embedding_hnsw_idx
  ON public.shop_knowledge USING hnsw (embedding vector_cosine_ops);

ALTER TABLE public.shop_knowledge ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shop_knowledge_tenant_isolation ON public.shop_knowledge;
CREATE POLICY shop_knowledge_tenant_isolation ON public.shop_knowledge
  FOR ALL USING (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  )
  WITH CHECK (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  );

CREATE OR REPLACE FUNCTION public.match_shop_knowledge(
  p_shop_id uuid,
  p_query_embedding vector(1536),
  p_match_count int DEFAULT 4,
  p_min_similarity real DEFAULT 0.4
)
RETURNS TABLE (
  id uuid,
  source_name text,
  content text,
  similarity real
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    k.id,
    k.source_name,
    k.content,
    (1 - (k.embedding <=> p_query_embedding))::real AS similarity
  FROM public.shop_knowledge k
  WHERE k.shop_id = p_shop_id
    AND k.embedding IS NOT NULL
    AND (1 - (k.embedding <=> p_query_embedding)) >= p_min_similarity
  ORDER BY k.embedding <=> p_query_embedding ASC
  LIMIT p_match_count;
$$;

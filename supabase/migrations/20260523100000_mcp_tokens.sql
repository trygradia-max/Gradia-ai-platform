-- Per-shop bearer tokens for the Gradia Internal MCP server. An agent
-- (Builder / Co-owner / external Claude Desktop) authenticates by
-- presenting `Authorization: Bearer gri_<random>` and the MCP route
-- resolves that to a shop_id, then runs every tool through that
-- shop's RLS scope.
--
-- We store the SHA-256 of the token, not the token itself, so DB
-- compromise can't be used to impersonate a shop. The plaintext is
-- shown once at mint time and never again.
-- Idempotent.

CREATE TABLE IF NOT EXISTS public.mcp_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops (id) ON DELETE CASCADE,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS mcp_tokens_shop_id_idx
  ON public.mcp_tokens (shop_id, created_at DESC);

ALTER TABLE public.mcp_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mcp_tokens_tenant_isolation ON public.mcp_tokens;
CREATE POLICY mcp_tokens_tenant_isolation ON public.mcp_tokens
  FOR ALL USING (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  )
  WITH CHECK (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  );

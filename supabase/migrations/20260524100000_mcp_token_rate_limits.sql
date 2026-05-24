-- Per-token daily rate limit counter for the Internal MCP. Cheap
-- defense: each token is allowed N requests per UTC day; the auth
-- helper bumps the counter on success and rejects past the cap.
--
-- Race-tolerant by design — concurrent requests can over-count by a
-- handful; that's fine for a soft pilot-scale limit. If we ever
-- need precise quotas we'd switch to a counter table or an atomic
-- RPC.
-- Idempotent.

ALTER TABLE public.mcp_tokens
  ADD COLUMN IF NOT EXISTS requests_today bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS usage_date date NOT NULL DEFAULT CURRENT_DATE;

/**
 * Bearer-token auth for the Gradia Internal MCP. Tokens are minted
 * via the mintMcpToken action, shown to the operator once, and
 * stored as SHA-256 hashes so DB compromise alone can't impersonate
 * a shop.
 *
 * Plaintext format: gri_<32 hex chars>. The prefix is purely
 * cosmetic; auth checks the SHA-256.
 */

import { createHash, randomBytes } from "node:crypto"

import { createServiceClient } from "@/lib/supabase/service"

const TOKEN_PREFIX = "gri_"
const TOKEN_RAW_BYTES = 24 // 48 hex chars; ~192 bits of entropy

export function generateMcpToken(): { plaintext: string; hash: string } {
  const hex = randomBytes(TOKEN_RAW_BYTES).toString("hex")
  const plaintext = `${TOKEN_PREFIX}${hex}`
  return { plaintext, hash: hashMcpToken(plaintext) }
}

export function hashMcpToken(plaintext: string): string {
  return createHash("sha256").update(plaintext.trim()).digest("hex")
}

export type ResolvedMcpAuth = {
  shopId: string
  shopName: string
  ownerId: string
  tokenId: string
}

/**
 * Validates a bearer header and returns the shop it's bound to.
 * Bumps last_used_at as a side-effect. Returns null when the
 * header is missing, malformed, or revoked — callers respond 401.
 */
export async function resolveMcpAuth(
  authorization: string | null
): Promise<ResolvedMcpAuth | null> {
  if (!authorization) return null
  const [scheme, raw] = authorization.split(" ")
  if (scheme?.toLowerCase() !== "bearer" || !raw) return null
  const trimmed = raw.trim()
  if (!trimmed.startsWith(TOKEN_PREFIX)) return null

  const supabase = createServiceClient()
  const hash = hashMcpToken(trimmed)
  const { data, error } = await supabase
    .from("mcp_tokens")
    .select("id, shop_id, revoked_at")
    .eq("token_hash", hash)
    .maybeSingle()
  if (error || !data) return null

  const row = data as {
    id: string
    shop_id: string
    revoked_at: string | null
  }
  if (row.revoked_at) return null

  const { data: shopRow } = await supabase
    .from("shops")
    .select("id, name, owner_id")
    .eq("id", row.shop_id)
    .maybeSingle()
  const shop = shopRow as
    | { id: string; name: string; owner_id: string }
    | null
  if (!shop) return null

  // Fire-and-forget last_used bump. Failure shouldn't block the call.
  void supabase
    .from("mcp_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", row.id)

  return {
    shopId: row.shop_id,
    shopName: shop.name,
    ownerId: shop.owner_id,
    tokenId: row.id,
  }
}

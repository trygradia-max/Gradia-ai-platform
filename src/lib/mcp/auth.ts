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

/** Per-token daily request cap. Tunable by env in a later pass. */
export const MCP_DAILY_REQUEST_CAP = 5000

export type AuthResult =
  | { ok: true; auth: ResolvedMcpAuth }
  | { ok: false; status: 401; reason: "missing" | "invalid" | "revoked" }
  | { ok: false; status: 429; resetInSeconds: number }

function secondsUntilUtcMidnight(): number {
  const now = new Date()
  const tomorrow = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      0,
      0,
      0,
      0
    )
  )
  return Math.max(1, Math.ceil((tomorrow.getTime() - now.getTime()) / 1000))
}

/**
 * Validates a bearer header, looks up the shop, enforces the
 * per-token daily rate limit, and bumps usage counters. Returns
 * a discriminated result the route handler can map to HTTP.
 *
 * The cap check + counter bump is race-tolerant by design — under
 * heavy concurrency a token can over-spend by a handful. That's
 * fine for a soft pilot limit.
 */
export async function resolveMcpAuth(
  authorization: string | null
): Promise<AuthResult> {
  if (!authorization)
    return { ok: false, status: 401, reason: "missing" }
  const [scheme, raw] = authorization.split(" ")
  if (scheme?.toLowerCase() !== "bearer" || !raw)
    return { ok: false, status: 401, reason: "invalid" }
  const trimmed = raw.trim()
  if (!trimmed.startsWith(TOKEN_PREFIX))
    return { ok: false, status: 401, reason: "invalid" }

  const supabase = createServiceClient()
  const hash = hashMcpToken(trimmed)
  const { data, error } = await supabase
    .from("mcp_tokens")
    .select("id, shop_id, revoked_at, requests_today, usage_date")
    .eq("token_hash", hash)
    .maybeSingle()
  if (error || !data) return { ok: false, status: 401, reason: "invalid" }

  const row = data as {
    id: string
    shop_id: string
    revoked_at: string | null
    requests_today: number
    usage_date: string
  }
  if (row.revoked_at) return { ok: false, status: 401, reason: "revoked" }

  // Reset the counter if we've crossed a UTC day boundary.
  const today = new Date().toISOString().slice(0, 10)
  const sameDay = row.usage_date === today
  const nextCount = sameDay ? row.requests_today + 1 : 1

  if (sameDay && row.requests_today >= MCP_DAILY_REQUEST_CAP) {
    return {
      ok: false,
      status: 429,
      resetInSeconds: secondsUntilUtcMidnight(),
    }
  }

  const { data: shopRow } = await supabase
    .from("shops")
    .select("id, name, owner_id")
    .eq("id", row.shop_id)
    .maybeSingle()
  const shop = shopRow as
    | { id: string; name: string; owner_id: string }
    | null
  if (!shop) return { ok: false, status: 401, reason: "invalid" }

  // Bump usage. Best-effort; failure shouldn't reject the request.
  void supabase
    .from("mcp_tokens")
    .update({
      last_used_at: new Date().toISOString(),
      requests_today: nextCount,
      usage_date: today,
    })
    .eq("id", row.id)

  return {
    ok: true,
    auth: {
      shopId: row.shop_id,
      shopName: shop.name,
      ownerId: shop.owner_id,
      tokenId: row.id,
    },
  }
}

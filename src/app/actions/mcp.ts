"use server"

import { revalidatePath } from "next/cache"

import { generateMcpToken } from "@/lib/mcp/auth"
import { requireShop, requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import type { McpTokenRow } from "@/lib/types/database"

export type MintMcpTokenResult =
  | { ok: true; id: string; plaintext: string }
  | { ok: false; error: string }

/**
 * Mints a new bearer token for the current active shop. Returns the
 * plaintext exactly once — UI is responsible for surfacing it
 * immediately and never asking the server for it again.
 */
export async function mintMcpToken(input: {
  name: string
}): Promise<MintMcpTokenResult> {
  const name = input.name.trim()
  if (!name) return { ok: false, error: "Name is required." }
  if (name.length > 80)
    return { ok: false, error: "Keep names under 80 chars." }

  await requireUser()
  const shop = await requireShop()
  const supabase = await createClient()

  const { plaintext, hash } = generateMcpToken()
  const { data, error } = await supabase
    .from("mcp_tokens")
    .insert({
      shop_id: shop.id,
      name,
      token_hash: hash,
    })
    .select("id")
    .single()
  if (error || !data) {
    return { ok: false, error: error?.message ?? "Could not mint token." }
  }

  revalidatePath("/settings")
  return { ok: true, id: (data as { id: string }).id, plaintext }
}

export type RevokeMcpTokenResult =
  | { ok: true }
  | { ok: false; error: string }

export async function revokeMcpToken(id: string): Promise<RevokeMcpTokenResult> {
  await requireUser()
  const shop = await requireShop()
  const supabase = await createClient()
  // P0-011 (audit L-1): explicit shop scope alongside RLS — defense in depth.
  const { error } = await supabase
    .from("mcp_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id)
    .eq("shop_id", shop.id)
  if (error) return { ok: false, error: error.message }
  revalidatePath("/settings")
  return { ok: true }
}

export async function listMcpTokensForCurrentShop(): Promise<McpTokenRow[]> {
  await requireUser()
  const shop = await requireShop()
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("mcp_tokens")
    .select("*")
    .eq("shop_id", shop.id)
    .order("created_at", { ascending: false })
  if (error || !data) return []
  return data as McpTokenRow[]
}

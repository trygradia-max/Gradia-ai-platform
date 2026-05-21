/**
 * Shop knowledge primitives. Owners drop FAQs, policies, brand voice
 * notes, and "things we don't do" into the knowledge base; drafters
 * and BI chat retrieve relevant chunks via pgvector cosine search.
 *
 * Embedding model + dim match interactions (text-embedding-3-small,
 * 1536) so we get to reuse the same shared embeddings lib + RLS
 * pattern.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import { embedText } from "@/lib/embeddings"
import type { ShopKnowledgeMatch, ShopKnowledgeRow } from "@/lib/types/database"

const MAX_CONTENT = 4_000

export type AddKnowledgeInput = {
  sourceName: string
  content: string
}

export type AddKnowledgeResult =
  | { ok: true; id: string }
  | { ok: false; error: string }

export async function addShopKnowledge(
  supabase: SupabaseClient,
  shopId: string,
  input: AddKnowledgeInput
): Promise<AddKnowledgeResult> {
  const sourceName = input.sourceName.trim()
  const content = input.content.trim()
  if (!sourceName) return { ok: false, error: "Source name is required." }
  if (!content) return { ok: false, error: "Content can't be empty." }
  if (content.length > MAX_CONTENT) {
    return {
      ok: false,
      error: `Keep entries under ${MAX_CONTENT.toLocaleString()} characters — split longer docs into multiple entries.`,
    }
  }

  let embedding: number[] | null = null
  try {
    embedding = await embedText(content)
  } catch (err) {
    console.warn("[knowledge] embedding failed, inserting without vector:", err)
  }

  const { data, error } = await supabase
    .from("shop_knowledge")
    .insert({
      shop_id: shopId,
      source_name: sourceName,
      content,
      embedding,
    })
    .select("id")
    .single()
  if (error || !data) {
    return { ok: false, error: error?.message ?? "Couldn't save entry." }
  }
  return { ok: true, id: (data as { id: string }).id }
}

export async function listShopKnowledge(
  supabase: SupabaseClient,
  shopId: string
): Promise<ShopKnowledgeRow[]> {
  const { data, error } = await supabase
    .from("shop_knowledge")
    .select("id, shop_id, source_name, content, created_at, updated_at")
    .eq("shop_id", shopId)
    .order("created_at", { ascending: false })
  if (error) {
    console.error("[knowledge] list failed:", error)
    return []
  }
  return (data as ShopKnowledgeRow[] | null) ?? []
}

export async function deleteShopKnowledge(
  supabase: SupabaseClient,
  shopId: string,
  id: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase
    .from("shop_knowledge")
    .delete()
    .eq("id", id)
    .eq("shop_id", shopId)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

/**
 * Retrieves the top-N most relevant knowledge entries for the given
 * query. Returns [] silently on embedding or RPC failure — drafters
 * fall back to their existing un-grounded behavior instead of erroring.
 */
export async function searchShopKnowledge(
  supabase: SupabaseClient,
  shopId: string,
  query: string,
  opts: { limit?: number; minSimilarity?: number } = {}
): Promise<ShopKnowledgeMatch[]> {
  const trimmed = query.trim()
  if (!trimmed) return []

  let queryEmbedding: number[]
  try {
    queryEmbedding = await embedText(trimmed)
  } catch (err) {
    console.warn("[knowledge] search embedding failed:", err)
    return []
  }

  const { data, error } = await supabase.rpc("match_shop_knowledge", {
    p_shop_id: shopId,
    p_query_embedding: queryEmbedding,
    p_match_count: opts.limit ?? 4,
    p_min_similarity: opts.minSimilarity ?? 0.4,
  })
  if (error) {
    console.warn("[knowledge] match RPC failed:", error)
    return []
  }
  return (data as ShopKnowledgeMatch[] | null) ?? []
}

/**
 * Renders a set of matches as a single block of text we can splice
 * into drafter prompts. Keeps each entry labeled with its source so
 * the LLM can name-drop it if appropriate.
 */
export function formatKnowledgeForPrompt(
  matches: ShopKnowledgeMatch[]
): string {
  if (matches.length === 0) return ""
  return matches
    .map((m) => `[${m.source_name}]\n${m.content}`)
    .join("\n\n---\n\n")
}

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

import { embedText, embedTexts } from "@/lib/embeddings"
import type { ShopKnowledgeMatch, ShopKnowledgeRow } from "@/lib/types/database"

const MAX_CONTENT = 4_000
const CHUNK_TARGET_CHARS = 900
const CHUNK_MAX_CHARS = 1500
const BULK_MAX_CHARS = 80_000

/**
 * Paragraph-aware chunker. Used by addShopKnowledgeBulk so owners
 * can paste a longer doc and have it split into embeddable units:
 *   1. Normalize line endings.
 *   2. Split on blank-line paragraph boundaries.
 *   3. Group adjacent paragraphs into ~CHUNK_TARGET chunks; never
 *      cross CHUNK_MAX.
 *   4. If a single paragraph blows past CHUNK_MAX, hard-split it on
 *      sentence boundaries (then on whitespace as last resort).
 *
 * Returns the cleaned chunk strings in source order.
 */
export function chunkText(input: string): string[] {
  const normalized = input.replace(/\r\n?/g, "\n").trim()
  if (!normalized) return []

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)

  const chunks: string[] = []
  let current = ""

  const flush = () => {
    const trimmed = current.trim()
    if (trimmed) chunks.push(trimmed)
    current = ""
  }

  for (const para of paragraphs) {
    if (para.length > CHUNK_MAX_CHARS) {
      // Flush whatever we were collecting first, then hard-split the
      // monster paragraph into its own chunks.
      flush()
      for (const piece of splitOversized(para)) {
        chunks.push(piece)
      }
      continue
    }
    const candidate = current ? `${current}\n\n${para}` : para
    if (candidate.length > CHUNK_TARGET_CHARS && current) {
      flush()
      current = para
    } else {
      current = candidate
    }
  }
  flush()
  return chunks
}

function splitOversized(text: string): string[] {
  // Sentence-boundary split, then merge greedy up to CHUNK_TARGET.
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
  const out: string[] = []
  let buf = ""
  for (const s of sentences) {
    if (s.length > CHUNK_MAX_CHARS) {
      // Last resort: chop on whitespace at CHUNK_MAX.
      if (buf.trim()) out.push(buf.trim())
      buf = ""
      for (let i = 0; i < s.length; i += CHUNK_MAX_CHARS) {
        out.push(s.slice(i, i + CHUNK_MAX_CHARS))
      }
      continue
    }
    const candidate = buf ? `${buf} ${s}` : s
    if (candidate.length > CHUNK_TARGET_CHARS && buf) {
      out.push(buf.trim())
      buf = s
    } else {
      buf = candidate
    }
  }
  if (buf.trim()) out.push(buf.trim())
  return out
}

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

export type AddBulkKnowledgeResult =
  | { ok: true; inserted: number; ids: string[] }
  | { ok: false; error: string }

/**
 * Bulk-add a longer document: chunkText splits it, embedTexts
 * batches the embeddings (one OpenAI round trip), then we insert
 * all chunks under the same source_name in one supabase call. Each
 * chunk is its own row so retrieval can be granular — the operator
 * is naming the doc (e.g. "Brand voice guide"), not each chunk.
 */
export async function addShopKnowledgeBulk(
  supabase: SupabaseClient,
  shopId: string,
  input: AddKnowledgeInput
): Promise<AddBulkKnowledgeResult> {
  const sourceName = input.sourceName.trim()
  const raw = input.content.trim()
  if (!sourceName) return { ok: false, error: "Source name is required." }
  if (!raw) return { ok: false, error: "Content can't be empty." }
  if (raw.length > BULK_MAX_CHARS) {
    return {
      ok: false,
      error: `Doc is too long — keep it under ${BULK_MAX_CHARS.toLocaleString()} chars or split it yourself.`,
    }
  }

  const chunks = chunkText(raw)
  if (chunks.length === 0) {
    return { ok: false, error: "Couldn't find any text to save." }
  }

  let embeddings: (number[] | null)[]
  try {
    const vectors = await embedTexts(chunks)
    embeddings = vectors
  } catch (err) {
    console.warn(
      "[knowledge] bulk embedding failed, inserting without vectors:",
      err
    )
    embeddings = chunks.map(() => null)
  }

  const rows = chunks.map((content, i) => ({
    shop_id: shopId,
    source_name: sourceName,
    content,
    embedding: embeddings[i] ?? null,
  }))

  const { data, error } = await supabase
    .from("shop_knowledge")
    .insert(rows)
    .select("id")
  if (error) {
    return { ok: false, error: error.message }
  }
  const ids = ((data as { id: string }[] | null) ?? []).map((r) => r.id)
  return { ok: true, inserted: ids.length, ids }
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

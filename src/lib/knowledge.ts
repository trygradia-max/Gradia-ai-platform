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
import type {
  ReviewedAgentMemoryMatch,
  ReviewedMemoryRevisionRow,
  ShopKnowledgeMatch,
  ShopKnowledgeRow,
} from "@/lib/types/database"

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
  | { ok: true; id: string; revision: number; safetyStatus: string }
  | { ok: false; error: string }

type CandidateRpcResult = {
  source_id: string
  revision: number
  chunks: number
  state: "candidate"
  safety_status: "clean" | "flagged" | "blocked"
  safety_flags: string[]
}

async function createCandidate(
  supabase: SupabaseClient,
  input: {
    shopId: string
    sourceName: string
    rawContent: string
    chunks: string[]
    embeddings: (number[] | null)[]
    sourceId?: string
    expectedRevision?: number
  }
): Promise<CandidateRpcResult> {
  const { data, error } = await supabase.rpc("create_reviewed_memory_candidate", {
    p_shop: input.shopId,
    p_source_name: input.sourceName,
    p_content: input.rawContent,
    p_chunks: input.chunks.map((content, index) => ({
      content,
      embedding: input.embeddings[index] ?? null,
    })),
    p_source: input.sourceId ?? null,
    p_expected_revision: input.expectedRevision ?? null,
    p_valid_from: null,
    p_valid_until: null,
    p_retention_until: null,
  })
  if (error || !data) {
    throw new Error(error?.message ?? "Couldn't save memory candidate.")
  }
  return data as CandidateRpcResult
}

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

  try {
    const candidate = await createCandidate(supabase, {
      shopId,
      sourceName,
      rawContent: content,
      chunks: [content],
      embeddings: [embedding],
    })
    return {
      ok: true,
      id: candidate.source_id,
      revision: candidate.revision,
      safetyStatus: candidate.safety_status,
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Couldn't save entry.",
    }
  }
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

  try {
    const candidate = await createCandidate(supabase, {
      shopId,
      sourceName,
      rawContent: raw,
      chunks,
      embeddings,
    })
    return {
      ok: true,
      inserted: candidate.chunks,
      ids: [candidate.source_id],
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Couldn't save document.",
    }
  }
}

export async function listShopKnowledge(
  supabase: SupabaseClient,
  shopId: string
): Promise<ShopKnowledgeRow[]> {
  const { data, error } = await supabase
    .from("published_shop_knowledge")
    .select("id, shop_id, source_name, content, source_id, revision, content_hash, published_at, created_at, updated_at")
    .eq("shop_id", shopId)
    .order("created_at", { ascending: false })
  if (error) {
    console.error("[knowledge] list failed:", error)
    return []
  }
  return (data as ShopKnowledgeRow[] | null) ?? []
}

export async function listReviewedMemory(
  supabase: SupabaseClient,
  shopId: string
): Promise<ReviewedMemoryRevisionRow[]> {
  const [revisionResult, sourceResult, activeResult] = await Promise.all([
    supabase
      .from("reviewed_memory_revisions")
      .select("shop_id, source_id, revision, state, raw_content, content_hash, safety_status, safety_flags, author_id, reviewed_by, reviewed_at, published_by, published_at, valid_from, valid_until, retention_until, supersedes_revision, created_at")
      .eq("shop_id", shopId)
      .neq("state", "deleted")
      .order("created_at", { ascending: false }),
    supabase
      .from("reviewed_memory_sources")
      .select("id, source_name")
      .eq("shop_id", shopId),
    supabase
      .from("reviewed_memory_active")
      .select("source_id, revision")
      .eq("shop_id", shopId),
  ])
  if (revisionResult.error || sourceResult.error || activeResult.error) {
    console.error(
      "[knowledge] reviewed list failed:",
      revisionResult.error ?? sourceResult.error ?? activeResult.error
    )
    return []
  }
  const names = new Map(
    ((sourceResult.data as { id: string; source_name: string }[] | null) ?? [])
      .map((source) => [source.id, source.source_name])
  )
  const active = new Map(
    ((activeResult.data as { source_id: string; revision: number }[] | null) ?? [])
      .map((row) => [row.source_id, row.revision])
  )
  return ((revisionResult.data as Omit<ReviewedMemoryRevisionRow, "source_name" | "active_revision">[] | null) ?? [])
    .map((row) => ({
      ...row,
      source_name: names.get(row.source_id) ?? "Unknown source",
      active_revision: active.get(row.source_id) ?? null,
    }))
}

export type MemoryMutationResult =
  | { ok: true; outcome: string; knowledgeRevision?: number }
  | { ok: false; error: string }

export async function reviewMemoryRevision(
  supabase: SupabaseClient,
  shopId: string,
  sourceId: string,
  revision: number
): Promise<MemoryMutationResult> {
  const { data, error } = await supabase.rpc("review_memory_revision", {
    p_shop: shopId,
    p_source: sourceId,
    p_revision: revision,
  })
  if (error) return { ok: false, error: error.message }
  if (data !== true) return { ok: false, error: "This candidate changed or is blocked from review." }
  return { ok: true, outcome: "reviewed" }
}

export async function publishMemoryRevision(
  supabase: SupabaseClient,
  shopId: string,
  sourceId: string,
  revision: number,
  expectedActive: number | null
): Promise<MemoryMutationResult> {
  const { data, error } = await supabase.rpc("publish_memory_revision", {
    p_shop: shopId,
    p_source: sourceId,
    p_revision: revision,
    p_expected_active: expectedActive,
  })
  if (error) return { ok: false, error: error.message }
  const result = data as { outcome?: string; knowledge_revision?: number } | null
  if (result?.outcome !== "published") {
    return {
      ok: false,
      error: result?.outcome === "conflicted"
        ? "A published source with this name conflicts with the candidate. Resolve it before activation."
        : "This revision is not ready to publish.",
    }
  }
  return {
    ok: true,
    outcome: result.outcome,
    knowledgeRevision: result.knowledge_revision,
  }
}

export async function removeMemoryRevision(
  supabase: SupabaseClient,
  shopId: string,
  sourceId: string,
  revision: number,
  expectedActive: number | null
): Promise<MemoryMutationResult> {
  const { data, error } = await supabase.rpc("remove_memory_revision", {
    p_shop: shopId,
    p_source: sourceId,
    p_revision: revision,
    p_expected_active: expectedActive,
  })
  if (error) return { ok: false, error: error.message }
  const result = data as { outcome?: string; knowledge_revision?: number } | null
  if (!result?.outcome) return { ok: false, error: "Memory removal was not confirmed." }
  return {
    ok: true,
    outcome: result.outcome,
    knowledgeRevision: result.knowledge_revision,
  }
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

export type ReviewedMemoryGrant = {
  sourceId: string
  revision: number
}

/**
 * Agent retrieval is narrower than general published shop retrieval: every
 * source and revision must be present in the employee's reviewed grant set and
 * must still be the active publication. Revocation therefore fails closed.
 */
export async function searchReviewedAgentMemory(
  supabase: SupabaseClient,
  shopId: string,
  grants: readonly ReviewedMemoryGrant[],
  query: string,
  opts: { limit?: number; minSimilarity?: number } = {}
): Promise<ReviewedAgentMemoryMatch[]> {
  const trimmed = query.trim()
  if (!trimmed || grants.length === 0) return []
  let queryEmbedding: number[]
  try {
    queryEmbedding = await embedText(trimmed)
  } catch (error) {
    console.warn("[knowledge] reviewed search embedding failed:", error)
    return []
  }
  const { data, error } = await supabase.rpc("match_reviewed_agent_memory", {
    p_shop_id: shopId,
    p_grants: grants.map((grant) => ({
      source_id: grant.sourceId,
      revision: grant.revision,
    })),
    p_query_embedding: queryEmbedding,
    p_match_count: opts.limit ?? 4,
    p_min_similarity: opts.minSimilarity ?? 0.4,
  })
  if (error) {
    console.warn("[knowledge] reviewed memory match failed:", error)
    return []
  }
  return (data as ReviewedAgentMemoryMatch[] | null) ?? []
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

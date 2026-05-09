/**
 * Shared memory layer — the brain every channel reads and writes to.
 *
 * Voice (Vapi), email (Aurinko), SMS, and any future channel funnel through
 * the same primitives:
 *   - recordInteraction: log a touchpoint and embed it
 *   - recentInteractions: chronological history (for short-term recall)
 *   - searchCustomerMemory: semantic search (for long-term recall)
 *   - recentChannelActivity: cross-channel sync flag
 *     ("John also emailed 2 hours ago about Ceramic Coating")
 *
 * Helpers take any SupabaseClient — pass a service-role client from agent
 * backends (no user session) or a user-session client from server actions.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import { EMBEDDING_MODEL, embedText } from "@/lib/embeddings"
import type {
  InteractionChannel,
  InteractionRole,
  InteractionRow,
  MatchedInteraction,
} from "@/lib/types/database"

export type RecordInteractionInput = {
  shopId: string
  customerId: string | null
  channel: InteractionChannel
  role: InteractionRole
  content: string
  metadata?: Record<string, unknown>
  occurredAt?: Date
}

export type RecordInteractionResult =
  | { ok: true; id: string; embedded: boolean }
  | { ok: false; error: string }

/**
 * Logs a customer touchpoint and embeds the content. Embedding is best-
 * effort: if the embeddings API fails, the row is still written with a
 * NULL embedding so the interaction isn't lost. A future backfill job can
 * fill in NULLs.
 */
export async function recordInteraction(
  supabase: SupabaseClient,
  input: RecordInteractionInput
): Promise<RecordInteractionResult> {
  const content = input.content.trim()
  if (!content) {
    return { ok: false, error: "Cannot record empty interaction" }
  }

  let embedding: number[] | null = null
  let embeddingModel: string | null = null
  try {
    embedding = await embedText(content)
    embeddingModel = EMBEDDING_MODEL
  } catch (err) {
    console.error("[memory] embed failed (storing without embedding):", err)
  }

  const { data, error } = await supabase
    .from("interactions")
    .insert({
      shop_id: input.shopId,
      customer_id: input.customerId,
      channel: input.channel,
      role: input.role,
      content,
      metadata: input.metadata ?? {},
      embedding,
      embedding_model: embeddingModel,
      occurred_at: (input.occurredAt ?? new Date()).toISOString(),
    })
    .select("id")
    .single()

  if (error || !data) {
    return { ok: false, error: error?.message ?? "Could not save interaction" }
  }

  return { ok: true, id: data.id, embedded: embedding !== null }
}

/**
 * Time-ordered recent history for a customer. No embedding query — cheap.
 * Use for "show me the last N messages from this person."
 */
export async function recentInteractions(
  supabase: SupabaseClient,
  shopId: string,
  customerId: string,
  limit = 20
): Promise<InteractionRow[]> {
  const { data, error } = await supabase
    .from("interactions")
    .select("*")
    .eq("shop_id", shopId)
    .eq("customer_id", customerId)
    .order("occurred_at", { ascending: false })
    .limit(limit)

  if (error) {
    throw new Error(error.message)
  }
  return (data as InteractionRow[] | null) ?? []
}

export type SearchMemoryOptions = {
  limit?: number
  /** 0..1 cosine similarity threshold; 0.5 is a reasonable default. */
  minSimilarity?: number
}

/**
 * Semantic search across a customer's history. Embeds the query, calls the
 * match_customer_memory RPC, returns matches above the similarity floor.
 *
 * Pass customerId=null to search across all customers in the shop (rarely
 * what you want, but useful for "did anyone ever ask about ceramic?").
 */
export async function searchCustomerMemory(
  supabase: SupabaseClient,
  shopId: string,
  customerId: string | null,
  query: string,
  opts: SearchMemoryOptions = {}
): Promise<MatchedInteraction[]> {
  const trimmed = query.trim()
  if (!trimmed) return []

  const queryEmbedding = await embedText(trimmed)
  const matchCount = opts.limit ?? 6
  const minSimilarity = opts.minSimilarity ?? 0.5

  const { data, error } = await supabase.rpc("match_customer_memory", {
    p_shop_id: shopId,
    p_customer_id: customerId,
    p_query_embedding: queryEmbedding,
    p_match_count: matchCount,
    p_min_similarity: minSimilarity,
  })

  if (error) {
    throw new Error(error.message)
  }
  return (data as MatchedInteraction[] | null) ?? []
}

export type ChannelActivitySummary = {
  channel: InteractionChannel
  occurred_at: string
  preview: string
}

/**
 * Cross-channel sync flag. Returns the most recent activity per channel
 * (excluding the channel currently in use), so an inbound voice agent can
 * surface "John also emailed 2 hours ago about Ceramic Coating."
 */
export async function recentChannelActivity(
  supabase: SupabaseClient,
  shopId: string,
  customerId: string,
  options: {
    excludeChannel?: InteractionChannel
    withinMinutes?: number
    perChannelLimit?: number
  } = {}
): Promise<ChannelActivitySummary[]> {
  const within = options.withinMinutes ?? 24 * 60
  const cutoff = new Date(Date.now() - within * 60 * 1000).toISOString()

  let query = supabase
    .from("interactions")
    .select("channel, content, occurred_at")
    .eq("shop_id", shopId)
    .eq("customer_id", customerId)
    .gte("occurred_at", cutoff)
    .order("occurred_at", { ascending: false })
    .limit(50)

  if (options.excludeChannel) {
    query = query.neq("channel", options.excludeChannel)
  }

  const { data, error } = await query
  if (error) {
    throw new Error(error.message)
  }

  // Reduce to most-recent-per-channel.
  const seen = new Map<InteractionChannel, ChannelActivitySummary>()
  for (const row of (data ?? []) as Array<{
    channel: InteractionChannel
    content: string
    occurred_at: string
  }>) {
    if (seen.has(row.channel)) continue
    seen.set(row.channel, {
      channel: row.channel,
      occurred_at: row.occurred_at,
      preview: row.content.slice(0, 140),
    })
  }
  return Array.from(seen.values())
}

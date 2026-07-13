/**
 * Drafting grounding — the shop's service menu + knowledge base, rendered as a
 * compact text block the custom drafters splice into their prompts so outbound
 * messages reflect what the shop actually offers and how it runs.
 *
 * Uses listShopKnowledge (plain text, NO embedding) so grounding works even
 * when the embeddings provider is down — unlike semantic search. Capped so it
 * never blows the drafter's context budget.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import { listShopKnowledge } from "@/lib/knowledge"
import { getReviewLink } from "@/lib/review-link"
import { describePrice, resolveDurationMinutes } from "@/lib/service-pricing"
import type { ServiceRow } from "@/lib/types/database"

const MAX_CHARS = 2_500
const MAX_KNOWLEDGE_ENTRIES = 12

export async function buildDrafterGrounding(
  supabase: SupabaseClient,
  shopId: string
): Promise<string | null> {
  const [serviceBlock, knowledge, reviewBlock] = await Promise.all([
    (async () => {
      // Prices resolve through lib/service-pricing so Whisper drafts quote
      // the same numbers as the voice agent and CRM quotes.
      const { data } = await supabase
        .from("services")
        .select(
          "name, price_cents, duration_minutes, base_price_by_size, duration_by_size"
        )
        .eq("shop_id", shopId)
      const rows =
        (data as
          | Pick<
              ServiceRow,
              | "name"
              | "price_cents"
              | "duration_minutes"
              | "base_price_by_size"
              | "duration_by_size"
            >[]
          | null) ?? []
      if (!rows.length) return ""
      const lines = rows.map(
        (s) =>
          `- ${s.name}: ${describePrice(s)} (${resolveDurationMinutes(s)} min)`
      )
      return `Service menu:\n${lines.join("\n")}`
    })(),
    listShopKnowledge(supabase, shopId),
    (async () => {
      // The review link grounds any review-request draft — including the
      // on-demand "send Marcus a review request" path through the box.
      const { data } = await supabase
        .from("shops")
        .select("settings")
        .eq("id", shopId)
        .maybeSingle()
      const link = getReviewLink(data as { settings?: Record<string, unknown> } | null)
      return link ? `Our public review link: ${link}` : ""
    })(),
  ])

  const knowledgeBlock = knowledge
    .slice(0, MAX_KNOWLEDGE_ENTRIES)
    .map((k) => `[${k.source_name}] ${k.content}`)
    .join("\n\n")

  const combined = [serviceBlock, knowledgeBlock, reviewBlock]
    .filter(Boolean)
    .join("\n\n")
    .trim()
  if (!combined) return null
  return combined.length > MAX_CHARS ? `${combined.slice(0, MAX_CHARS)}…` : combined
}

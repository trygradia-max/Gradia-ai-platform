/**
 * Read + write helpers for /chat persistence. RLS already scopes
 * everything to the shop's owner, so these helpers don't re-check
 * shop_id beyond passing it through. The CASCADE FKs on conversation
 * → message mean deleting a conversation cleans up its turns.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import { createClient } from "@/lib/supabase/server"
import { requireShop, requireUser } from "@/lib/shop"
import type {
  BiConversationRow,
  BiMessageRole,
  BiMessageRow,
} from "@/lib/types/database"

const TITLE_MAX = 80

function deriveTitle(firstUserMessage: string): string {
  const trimmed = firstUserMessage.trim().replace(/\s+/g, " ")
  if (trimmed.length <= TITLE_MAX) return trimmed
  return `${trimmed.slice(0, TITLE_MAX - 1).trim()}…`
}

const CONVERSATION_LIST_LIMIT = 50

export type ConversationSummary = Pick<
  BiConversationRow,
  "id" | "title" | "updated_at" | "created_at"
>

async function loadConversationMessages(
  conversation: BiConversationRow
): Promise<BiMessageRow[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("bi_messages")
    .select("*")
    .eq("conversation_id", conversation.id)
    .order("created_at", { ascending: true })
  if (error) throw new Error(error.message)
  return (data as BiMessageRow[] | null) ?? []
}

export async function getLatestConversationWithMessages(): Promise<
  | { conversation: BiConversationRow; messages: BiMessageRow[] }
  | null
> {
  const shop = await requireShop()
  const supabase = await createClient()

  const { data: convRow, error: convErr } = await supabase
    .from("bi_conversations")
    .select("*")
    .eq("shop_id", shop.id)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (convErr) throw new Error(convErr.message)
  if (!convRow) return null
  const conversation = convRow as BiConversationRow
  const messages = await loadConversationMessages(conversation)
  return { conversation, messages }
}

export async function getConversationByIdWithMessages(
  conversationId: string
): Promise<
  | { conversation: BiConversationRow; messages: BiMessageRow[] }
  | null
> {
  const shop = await requireShop()
  const supabase = await createClient()

  const { data: convRow, error: convErr } = await supabase
    .from("bi_conversations")
    .select("*")
    .eq("id", conversationId)
    .eq("shop_id", shop.id)
    .maybeSingle()
  if (convErr) throw new Error(convErr.message)
  if (!convRow) return null
  const conversation = convRow as BiConversationRow
  const messages = await loadConversationMessages(conversation)
  return { conversation, messages }
}

export async function listConversationsForCurrentShop(): Promise<
  ConversationSummary[]
> {
  const shop = await requireShop()
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("bi_conversations")
    .select("id, title, updated_at, created_at")
    .eq("shop_id", shop.id)
    .order("updated_at", { ascending: false })
    .limit(CONVERSATION_LIST_LIMIT)
  if (error) throw new Error(error.message)
  return (data as ConversationSummary[] | null) ?? []
}

/**
 * Used inside the streaming route after we've authed and resolved
 * the shop. Caller passes its own Supabase client (the user-session
 * one) and the resolved shop/user IDs so we don't re-call requireShop
 * mid-request.
 */
export async function ensureConversation(input: {
  supabase: SupabaseClient
  shopId: string
  ownerId: string
  conversationId: string | null
  firstUserMessage: string
}): Promise<BiConversationRow> {
  if (input.conversationId) {
    const { data, error } = await input.supabase
      .from("bi_conversations")
      .select("*")
      .eq("id", input.conversationId)
      .eq("shop_id", input.shopId)
      .single()
    if (error || !data) {
      throw new Error("Conversation not found.")
    }
    return data as BiConversationRow
  }

  const { data, error } = await input.supabase
    .from("bi_conversations")
    .insert({
      shop_id: input.shopId,
      owner_id: input.ownerId,
      title: deriveTitle(input.firstUserMessage),
    })
    .select("*")
    .single()
  if (error || !data) {
    throw new Error(error?.message ?? "Could not start a conversation.")
  }
  return data as BiConversationRow
}

export async function appendMessage(input: {
  supabase: SupabaseClient
  conversationId: string
  shopId: string
  role: BiMessageRole
  content: string
}): Promise<BiMessageRow | null> {
  const { data, error } = await input.supabase
    .from("bi_messages")
    .insert({
      conversation_id: input.conversationId,
      shop_id: input.shopId,
      role: input.role,
      content: input.content,
    })
    .select("*")
    .single()
  if (error || !data) {
    console.error("[bi-conversations] appendMessage failed:", error)
    return null
  }

  // Touch the conversation so it sorts to the top on next load.
  await input.supabase
    .from("bi_conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", input.conversationId)

  return data as BiMessageRow
}

/**
 * Server action target. Reused via the actions/ wrapper.
 */
export async function authedShopAndOwner(): Promise<{
  shopId: string
  ownerId: string
}> {
  const user = await requireUser()
  const shop = await requireShop()
  return { shopId: shop.id, ownerId: user.id }
}

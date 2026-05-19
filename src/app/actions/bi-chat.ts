"use server"

/**
 * Server actions for the /chat surface. The actual message persistence
 * happens inside the streaming route (where we also have the user
 * session for RLS); this file just covers explicit operator gestures
 * like "start a fresh thread" and the sheet that lists past threads.
 */

import { revalidatePath } from "next/cache"

import {
  listConversationsForCurrentShop,
  type ConversationSummary,
} from "@/lib/data/bi-conversations"
import { requireShop, requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"

export type ListConversationsResult =
  | { ok: true; items: ConversationSummary[] }
  | { ok: false; error: string }

/**
 * Used by the chat-history sheet — fetches the recent threads when
 * the drawer opens. RLS scopes everything per shop.
 */
export async function listChatConversations(): Promise<ListConversationsResult> {
  try {
    await requireUser()
    const items = await listConversationsForCurrentShop()
    return { ok: true, items }
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error ? err.message : "Couldn't load conversations.",
    }
  }
}

export type StartNewConversationResult =
  | { ok: true }
  | { ok: false; error: string }

/**
 * "New chat" button. We don't actually create a conversation row here —
 * conversations are lazy on first user message. This action just
 * revalidates `/chat` so a stale server-rendered transcript doesn't
 * confuse the client after a hard reload. The client-side handler
 * also clears the in-memory state.
 */
export async function startNewConversation(): Promise<StartNewConversationResult> {
  await requireUser()
  await requireShop()
  revalidatePath("/chat")
  return { ok: true }
}

export type DeleteConversationResult =
  | { ok: true }
  | { ok: false; error: string }

/**
 * Removes a conversation and (via FK cascade) all its messages.
 */
export async function deleteConversation(
  conversationId: string
): Promise<DeleteConversationResult> {
  await requireUser()
  const shop = await requireShop()
  const supabase = await createClient()

  const { error } = await supabase
    .from("bi_conversations")
    .delete()
    .eq("id", conversationId)
    .eq("shop_id", shop.id)

  if (error) return { ok: false, error: error.message }
  revalidatePath("/chat")
  return { ok: true }
}

"use server"

import { revalidatePath } from "next/cache"

import {
  addShopKnowledge,
  deleteShopKnowledge,
  type AddKnowledgeInput,
} from "@/lib/knowledge"
import { requireShop, requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"

export type SaveKnowledgeResult =
  | { ok: true; id: string }
  | { ok: false; error: string }

export async function saveKnowledgeEntry(
  input: AddKnowledgeInput
): Promise<SaveKnowledgeResult> {
  await requireUser()
  const shop = await requireShop()
  const supabase = await createClient()
  const result = await addShopKnowledge(supabase, shop.id, input)
  if (!result.ok) return result
  revalidatePath("/settings")
  return result
}

export type DeleteKnowledgeResult =
  | { ok: true }
  | { ok: false; error: string }

export async function deleteKnowledgeEntry(
  id: string
): Promise<DeleteKnowledgeResult> {
  await requireUser()
  const shop = await requireShop()
  const supabase = await createClient()
  const result = await deleteShopKnowledge(supabase, shop.id, id)
  if (!result.ok) return result
  revalidatePath("/settings")
  return result
}

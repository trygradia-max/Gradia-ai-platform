"use server"

import { revalidatePath } from "next/cache"

import {
  addShopKnowledge,
  addShopKnowledgeBulk,
  publishMemoryRevision,
  removeMemoryRevision,
  reviewMemoryRevision,
  type AddKnowledgeInput,
} from "@/lib/knowledge"
import { requireShop, requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import { markVoiceStale } from "@/lib/voice-provider"

export type SaveKnowledgeResult =
  | { ok: true; id: string; revision: number; safetyStatus: string }
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

export type SaveKnowledgeBulkResult =
  | { ok: true; inserted: number }
  | { ok: false; error: string }

export async function saveKnowledgeBulkEntry(
  input: AddKnowledgeInput
): Promise<SaveKnowledgeBulkResult> {
  await requireUser()
  const shop = await requireShop()
  const supabase = await createClient()
  const result = await addShopKnowledgeBulk(supabase, shop.id, input)
  if (!result.ok) return result
  revalidatePath("/settings")
  return { ok: true, inserted: result.inserted }
}

export type KnowledgeReviewResult =
  | { ok: true; outcome: string }
  | { ok: false; error: string }

export async function reviewKnowledgeEntry(input: {
  sourceId: string
  revision: number
}): Promise<KnowledgeReviewResult> {
  await requireUser()
  const shop = await requireShop()
  const supabase = await createClient()
  const result = await reviewMemoryRevision(
    supabase,
    shop.id,
    input.sourceId,
    input.revision
  )
  if (!result.ok) return result
  revalidatePath("/settings")
  return { ok: true, outcome: result.outcome }
}

export async function publishKnowledgeEntry(input: {
  sourceId: string
  revision: number
  expectedActive: number | null
}): Promise<KnowledgeReviewResult> {
  await requireUser()
  const shop = await requireShop()
  const supabase = await createClient()
  const result = await publishMemoryRevision(
    supabase,
    shop.id,
    input.sourceId,
    input.revision,
    input.expectedActive
  )
  if (!result.ok) return result
  await markVoiceStale(supabase, shop.id)
  revalidatePath("/settings")
  return { ok: true, outcome: result.outcome }
}

export async function removeKnowledgeEntry(input: {
  sourceId: string
  revision: number
  expectedActive: number | null
}): Promise<KnowledgeReviewResult> {
  await requireUser()
  const shop = await requireShop()
  const supabase = await createClient()
  const result = await removeMemoryRevision(
    supabase,
    shop.id,
    input.sourceId,
    input.revision,
    input.expectedActive
  )
  if (!result.ok) return result
  if (result.outcome === "revoked") {
    await markVoiceStale(supabase, shop.id)
  }
  revalidatePath("/settings")
  return { ok: true, outcome: result.outcome }
}

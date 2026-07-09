"use server"

import { revalidatePath } from "next/cache"

import { rejectFromDashboard } from "@/app/actions/approvals"
import { recordInteraction } from "@/lib/memory"
import { requireShop } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"

/**
 * Whisper suggestion queue (C6a) — the Today surface's data + dismiss.
 * Approve reuses approveFromDashboard (the one executor path). Dismiss is
 * a rejection PLUS a feedback row, so the suggestion engine can learn what
 * the owner keeps waving off.
 */

export type WhisperSuggestion = {
  pendingId: string
  kind: string
  why: string
  body: string
  customerName: string | null
  createdAt: string
}

export async function listWhisperSuggestions(): Promise<WhisperSuggestion[]> {
  const shop = await requireShop()
  const supabase = await createClient()
  const { data } = await supabase
    .from("pending_actions")
    .select("id, payload, created_at")
    .eq("shop_id", shop.id)
    .eq("status", "pending")
    .eq("payload->>source", "whisper_suggestion")
    .order("created_at", { ascending: false })
    .limit(6)
  return (
    (data as { id: string; payload: Record<string, unknown>; created_at: string }[] | null) ?? []
  ).map((row) => ({
    pendingId: row.id,
    kind: String(row.payload.suggestion_kind ?? "suggestion"),
    why: String(row.payload.why ?? ""),
    body: String(row.payload.body ?? ""),
    customerName:
      typeof row.payload.customer_name === "string" ? row.payload.customer_name : null,
    createdAt: row.created_at,
  }))
}

export type DismissResult = { ok: true } | { ok: false; error: string }

/** Dismiss = reject + a feedback row (spec: dismissals recorded as feedback). */
export async function dismissWhisperSuggestion(
  pendingId: string
): Promise<DismissResult> {
  const shop = await requireShop()
  const supabase = await createClient()

  const { data } = await supabase
    .from("pending_actions")
    .select("payload")
    .eq("id", pendingId)
    .eq("shop_id", shop.id)
    .maybeSingle()
  const payload = (data as { payload: Record<string, unknown> } | null)?.payload

  const result = await rejectFromDashboard(pendingId)
  if (!result.ok) return { ok: false, error: result.error }

  await recordInteraction(supabase, {
    shopId: shop.id,
    customerId:
      typeof payload?.customer_id === "string" ? payload.customer_id : null,
    channel: "note",
    role: "system",
    content: "Whisper suggestion dismissed by the owner.",
    metadata: {
      kind: "whisper_feedback",
      verdict: "dismissed",
      suggestion_kind: payload?.suggestion_kind ?? null,
      suggestion_ref: payload?.suggestion_ref ?? null,
    },
  })

  revalidatePath("/dashboard")
  return { ok: true }
}

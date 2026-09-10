"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import {
  repointCustomerChildren,
  type MergeChildTable,
} from "@/lib/merge-customers"
import { requireShop, requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import type { CustomerRow } from "@/lib/types/database"

const CANDIDATE_LIMIT = 100

const dncSchema = z.object({
  customer_id: z.string().uuid(),
  value: z.boolean(),
})

export type SetDoNotContactResult =
  | { ok: true; value: boolean }
  | { ok: false; error: string }

/**
 * Owner's manual do-not-contact switch (GRADIA_CUSTOMER_RECOVERY_SPEC §3.2 —
 * "honored ≤10 business days; the flag is immediate"). When on, the audience
 * resolver hard-blocks this customer from every outreach, recovered or not.
 */
export async function setCustomerDoNotContact(
  input: z.infer<typeof dncSchema>
): Promise<SetDoNotContactResult> {
  const parsed = dncSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: "Bad input." }

  await requireUser()
  const shop = await requireShop()
  const supabase = await createClient()

  const { error } = await supabase
    .from("customers")
    .update({ do_not_contact: parsed.data.value })
    .eq("id", parsed.data.customer_id)
    .eq("shop_id", shop.id)
  if (error) return { ok: false, error: error.message }

  revalidatePath(`/customers/${parsed.data.customer_id}`)
  revalidatePath("/customers")
  return { ok: true, value: parsed.data.value }
}

export type MergeCandidate = Pick<
  CustomerRow,
  "id" | "name" | "phone" | "email" | "updated_at"
>

/**
 * Lists possible merge partners for the customer the operator is
 * viewing. Same-shop only, current customer excluded, query matches
 * any identifier column. Capped at 100 — operator narrows with the
 * search field, doesn't paginate.
 */
export async function listMergeCandidates(input: {
  excludeId: string
  query: string
}): Promise<MergeCandidate[]> {
  await requireUser()
  const shop = await requireShop()
  const supabase = await createClient()

  let req = supabase
    .from("customers")
    .select(
      "id, name, phone, email, updated_at"
    )
    .eq("shop_id", shop.id)
    .neq("id", input.excludeId)

  const q = input.query.trim()
  if (q) {
    const safe = q.replace(/[,()]/g, "").slice(0, 80)
    const pattern = `%${safe}%`
    req = req.or(
      [
        `name.ilike.${pattern}`,
        `phone.ilike.${pattern}`,
        `email.ilike.${pattern}`,
      ].join(",")
    )
  }

  const { data, error } = await req
    .order("updated_at", { ascending: false })
    .limit(CANDIDATE_LIMIT)

  if (error) throw new Error(error.message)
  return (data as MergeCandidate[] | null) ?? []
}

const mergeSchema = z.object({
  winner_id: z.string().uuid(),
  loser_id: z.string().uuid(),
})

export type MergeCustomersResult =
  | {
      ok: true
      moved: Record<MergeChildTable, number>
      identifierConflicts: string[]
    }
  | { ok: false; error: string }

/** Atomically merge through the shared database operation. */
export async function mergeCustomers(
  input: z.infer<typeof mergeSchema>
): Promise<MergeCustomersResult> {
  const parsed = mergeSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: "Bad merge input." }
  }
  if (parsed.data.winner_id === parsed.data.loser_id) {
    return { ok: false, error: "Pick two different customers." }
  }

  await requireUser()
  const shop = await requireShop()
  const supabase = await createClient()

  const result = await repointCustomerChildren(supabase, shop.id, parsed.data.winner_id, parsed.data.loser_id)
  if (!result.ok) return {ok:false,error:result.error}
  const moved = result.moved
  const identifierConflicts: string[] = []
  revalidatePath("/customers")
  revalidatePath(`/customers/${parsed.data.winner_id}`)
  return { ok: true, moved, identifierConflicts }
}

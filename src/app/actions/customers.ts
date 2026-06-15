"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { requireShop, requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import type { CustomerRow } from "@/lib/types/database"

const CANDIDATE_LIMIT = 100

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
      moved: { leads: number; interactions: number; appointments: number }
      identifierConflicts: string[]
    }
  | { ok: false; error: string }

/**
 * Merges `loser` into `winner`:
 *   1. Reassigns leads / interactions / appointments from loser to
 *      winner. Done FIRST because interactions.customer_id is ON
 *      DELETE CASCADE — deleting the loser without reassigning would
 *      destroy the loser's whole timeline.
 *   2. Frees up loser's identifier columns by NULLing them, so the
 *      per-shop unique indexes don't block the absorption step.
 *   3. Copies any identifiers winner is missing from loser. Each
 *      copy is best-effort: a 23505 unique-violation means a third
 *      customer already owns that value — we skip that field and
 *      surface it in `identifierConflicts` so the operator knows.
 *   4. Deletes loser.
 *
 * Not transactional (Supabase JS doesn't expose pg transactions).
 * Race window is tiny at pilot scale; if step 4 fails after step 1,
 * the loser row is left with zero refs and can be deleted manually
 * or by re-running the merge.
 */
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

  const { data: rows, error: fetchErr } = await supabase
    .from("customers")
    .select("*")
    .eq("shop_id", shop.id)
    .in("id", [parsed.data.winner_id, parsed.data.loser_id])
  if (fetchErr) return { ok: false, error: fetchErr.message }

  const both = (rows as CustomerRow[] | null) ?? []
  if (both.length !== 2) {
    return { ok: false, error: "Couldn't find both customers in our shop." }
  }
  const winner = both.find((r) => r.id === parsed.data.winner_id)!
  const loser = both.find((r) => r.id === parsed.data.loser_id)!

  // 1. Reassign FK rows from loser → winner.
  const moved = { leads: 0, interactions: 0, appointments: 0 }

  const leadsRes = await supabase
    .from("leads")
    .update({ customer_id: winner.id })
    .eq("shop_id", shop.id)
    .eq("customer_id", loser.id)
    .select("id")
  if (leadsRes.error) {
    return { ok: false, error: `Couldn't move leads: ${leadsRes.error.message}` }
  }
  moved.leads = leadsRes.data?.length ?? 0

  const interactionsRes = await supabase
    .from("interactions")
    .update({ customer_id: winner.id })
    .eq("shop_id", shop.id)
    .eq("customer_id", loser.id)
    .select("id")
  if (interactionsRes.error) {
    return {
      ok: false,
      error: `Couldn't move history: ${interactionsRes.error.message}`,
    }
  }
  moved.interactions = interactionsRes.data?.length ?? 0

  const appointmentsRes = await supabase
    .from("appointments")
    .update({ customer_id: winner.id })
    .eq("shop_id", shop.id)
    .eq("customer_id", loser.id)
    .select("id")
  if (appointmentsRes.error) {
    return {
      ok: false,
      error: `Couldn't move appointments: ${appointmentsRes.error.message}`,
    }
  }
  moved.appointments = appointmentsRes.data?.length ?? 0

  // 2. Free up loser's identifier columns.
  await supabase
    .from("customers")
    .update({
      name: null,
      phone: null,
      email: null,
    })
    .eq("id", loser.id)

  // 3. Absorb each missing identifier on the winner — best-effort.
  const identifierConflicts: string[] = []
  const absorbCandidates: { field: keyof CustomerRow; value: string | null }[] = [
    { field: "name", value: winner.name ? null : loser.name },
    { field: "phone", value: winner.phone ? null : loser.phone },
    { field: "email", value: winner.email ? null : loser.email },
  ]

  for (const { field, value } of absorbCandidates) {
    if (!value) continue
    const { error: updErr } = await supabase
      .from("customers")
      .update({ [field]: value })
      .eq("id", winner.id)
    if (updErr) {
      if (updErr.code === "23505") {
        identifierConflicts.push(String(field))
      } else {
        // Unexpected — bail out but leave the FK reassignments in place.
        return { ok: false, error: updErr.message }
      }
    }
  }

  // 4. Delete loser.
  const delRes = await supabase
    .from("customers")
    .delete()
    .eq("id", loser.id)
    .eq("shop_id", shop.id)
  if (delRes.error) {
    return {
      ok: false,
      error: `Reassigned everything but couldn't delete the duplicate: ${delRes.error.message}`,
    }
  }

  revalidatePath("/customers")
  revalidatePath(`/customers/${winner.id}`)
  return { ok: true, moved, identifierConflicts }
}

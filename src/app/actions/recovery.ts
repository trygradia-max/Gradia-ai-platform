"use server"

import { revalidatePath } from "next/cache"

import { pushLeadToCrm } from "@/lib/crm-provider"
import { FEATURES } from "@/lib/features"
import { recordInteraction } from "@/lib/memory"
import {
  candidateToCustomerInput,
  loadJobCandidates,
  mergePatch,
} from "@/lib/recovery/review"
import { requireShop } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import type { CustomerRow } from "@/lib/types/database"

export type ApproveRecoveryResult =
  | { ok: true; added: number; merged: number }
  | { ok: false; error: string }

/**
 * Approve recovered candidates into the CRM (GRADIA_CUSTOMER_RECOVERY_SPEC §3.1
 * — "nothing touches the CRM until approved"). `new`/`ambiguous` keys insert a
 * customer (source=import); `merge_into` fills only the existing record's empty
 * fields. Every write is logged to the customer's timeline for the audit trail.
 *
 * Runs under the owner's RLS client, so it can only write the owner's own shop.
 */
export async function approveRecoveryCandidates(
  jobId: string,
  keys: string[]
): Promise<ApproveRecoveryResult> {
  if (!FEATURES.customerRecovery) return { ok: false, error: "Not available." }
  if (keys.length === 0) return { ok: true, added: 0, merged: 0 }

  const shop = await requireShop()
  const supabase = await createClient()

  const loaded = await loadJobCandidates(supabase, shop.id, jobId)
  if (!loaded) return { ok: false, error: "Import not found." }

  const selected = loaded.candidates.filter((c) => keys.includes(c.key))
  let added = 0
  let merged = 0

  for (const c of selected) {
    const input = candidateToCustomerInput(c)

    if (c.decision.kind === "merge_into") {
      const customerId = c.decision.customerId
      const { data } = await supabase
        .from("customers")
        .select("*")
        .eq("id", customerId)
        .eq("shop_id", shop.id)
        .maybeSingle()
      const existing = data as CustomerRow | null
      if (!existing) continue
      const patch = mergePatch(existing, input)
      if (Object.keys(patch).length > 0) {
        await supabase.from("customers").update(patch).eq("id", customerId)
      }
      merged += 1
      await recordInteraction(supabase, {
        shopId: shop.id,
        customerId,
        channel: "note",
        role: "system",
        content: "Updated from a customer-recovery import.",
        metadata: { source: "customer_recovery", import_job_id: jobId },
      })
      // Land the imported customer in any connected CRM through the same seam
      // as lead/booking approvals (NEXT-4). No-op for the CRM-less majority.
      await pushLeadToCrm({
        supabase,
        shopId: shop.id,
        customerId,
        customerName: existing.name ?? input.name ?? "Recovered customer",
        phone: existing.phone ?? input.phone,
        email: existing.email ?? input.email,
      })
    } else {
      // new (or owner-approved ambiguous) → insert; never auto-merge.
      const { data, error } = await supabase
        .from("customers")
        .insert({ shop_id: shop.id, ...input })
        .select("id")
        .single()
      if (error || !data) continue
      const newId = (data as { id: string }).id
      added += 1
      await recordInteraction(supabase, {
        shopId: shop.id,
        customerId: newId,
        channel: "note",
        role: "system",
        content: "Recovered from a customer-recovery import.",
        metadata: { source: "customer_recovery", import_job_id: jobId },
      })
      // Same CRM seam as lead/booking approvals (NEXT-4). No-op if no CRM.
      await pushLeadToCrm({
        supabase,
        shopId: shop.id,
        customerId: newId,
        customerName: input.name ?? "Recovered customer",
        phone: input.phone,
        email: input.email,
      })
    }
  }

  revalidatePath("/recovery")
  revalidatePath("/customers")
  return { ok: true, added, merged }
}

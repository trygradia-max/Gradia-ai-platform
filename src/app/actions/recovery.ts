"use server"

import { revalidatePath } from "next/cache"

import { pushLeadToCrm } from "@/lib/crm-provider"
import { FEATURES } from "@/lib/features"
import { recordInteraction } from "@/lib/memory"
import {
  buildErrorReportCsv,
  buildMergeUndo,
  candidateToCustomerInput,
  candidateVehicle,
  loadJobCandidates,
  mergePatch,
  type ReviewCandidate,
} from "@/lib/recovery/review"
import { upsertCustomerVehicle } from "@/lib/vehicles"
import { requireShop } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import type { CrmStage, CustomerRow } from "@/lib/types/database"

export type ApproveRecoveryResult =
  | { ok: true; added: number; merged: number; skipped: number }
  | { ok: false; error: string }

/** C7 duplicate strategies (spec §C7.4). "update" = fill empty fields (the
 *  P8 default); "skip" = leave the existing record untouched; "create" =
 *  insert anyway (the per-channel unique indexes still veto exact dupes). */
export type DuplicateStrategy = "update" | "skip" | "create"

/** Stages that still represent live pipeline work — these get a card. A
 *  booked/lost import row is history, not an open deal. */
const CARD_STAGES: CrmStage[] = ["new", "needs_quote", "quote_sent", "follow_up"]

/**
 * Approve recovered candidates into the CRM (GRADIA_CUSTOMER_RECOVERY_SPEC §3.1
 * — "nothing touches the CRM until approved"). `new`/`ambiguous` keys insert a
 * customer (source=import); `merge_into` follows the duplicate strategy. Every
 * write is logged to the customer's timeline WITH an undo pre-image, so
 * undoRecoveryImport can restore the exact pre-import state (C7).
 *
 * Runs under the owner's RLS client, so it can only write the owner's own shop.
 */
export async function approveRecoveryCandidates(
  jobId: string,
  keys: string[],
  opts: { duplicateStrategy?: DuplicateStrategy } = {}
): Promise<ApproveRecoveryResult> {
  if (!FEATURES.customerRecovery) return { ok: false, error: "Not available." }
  if (keys.length === 0) return { ok: true, added: 0, merged: 0, skipped: 0 }
  const strategy = opts.duplicateStrategy ?? "update"

  const shop = await requireShop()
  const supabase = await createClient()

  const loaded = await loadJobCandidates(supabase, shop.id, jobId)
  if (!loaded) return { ok: false, error: "Import not found." }

  const selected = loaded.candidates.filter((c) => keys.includes(c.key))
  let added = 0
  let merged = 0
  let skipped = 0

  for (const c of selected) {
    const input = candidateToCustomerInput(c)
    const vehicle = candidateVehicle(c)

    if (c.decision.kind === "merge_into" && strategy !== "create") {
      if (strategy === "skip") {
        skipped += 1
        continue
      }
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
      // Vehicle rides separately — find-or-create in the vehicles table,
      // never overwriting fields an existing row already has (C1). Created
      // rows carry import provenance for undo.
      await upsertCustomerVehicle(supabase, shop.id, customerId, vehicle, {
        importJobId: jobId,
      })
      const leadId = await createStageCard(supabase, shop.id, customerId, c)
      merged += 1
      await recordInteraction(supabase, {
        shopId: shop.id,
        customerId,
        channel: "note",
        role: "system",
        content: "Updated from a customer-recovery import.",
        metadata: {
          source: "customer_recovery",
          import_job_id: jobId,
          undo: {
            kind: "merge",
            prev: buildMergeUndo(existing as unknown as Record<string, unknown>, patch),
            created_lead_id: leadId,
          },
        },
      })
      await recordImportNotes(supabase, shop.id, customerId, c, jobId)
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
      // new (or owner-approved ambiguous, or strategy=create) → insert;
      // never auto-merge. The per-channel unique indexes veto exact dupes —
      // a vetoed "create" counts as skipped rather than failing the batch.
      const { data, error } = await supabase
        .from("customers")
        .insert({ shop_id: shop.id, ...input })
        .select("id")
        .single()
      if (error || !data) {
        skipped += 1
        continue
      }
      const newId = (data as { id: string }).id
      await upsertCustomerVehicle(supabase, shop.id, newId, vehicle, {
        importJobId: jobId,
      })
      const leadId = await createStageCard(supabase, shop.id, newId, c)
      added += 1
      await recordInteraction(supabase, {
        shopId: shop.id,
        customerId: newId,
        channel: "note",
        role: "system",
        content: "Recovered from a customer-recovery import.",
        metadata: {
          source: "customer_recovery",
          import_job_id: jobId,
          undo: { kind: "create", created_lead_id: leadId },
        },
      })
      await recordImportNotes(supabase, shop.id, newId, c, jobId)
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
  return { ok: true, added, merged, skipped }
}

type ActionClient = Awaited<ReturnType<typeof createClient>>

/**
 * C7: an imported row with a LIVE pipeline stage becomes a pipeline card so
 * the kanban (C2) starts populated. Best-effort — a lead needs a phone, and
 * the C1 `stage` column is linked after insert (pre-migration tolerance).
 * Returns the created lead id for the undo trail.
 */
async function createStageCard(
  supabase: ActionClient,
  shopId: string,
  customerId: string,
  c: ReviewCandidate
): Promise<string | null> {
  if (!c.stage || !CARD_STAGES.includes(c.stage)) return null
  const phone = c.phones[0]
  if (!phone) return null
  const vehicle = candidateVehicle(c)
  const { data, error } = await supabase
    .from("leads")
    .insert({
      shop_id: shopId,
      customer_id: customerId,
      customer_name: c.name ?? "Imported customer",
      phone,
      car_info: c.vehicle,
      vehicle_make: vehicle.make,
      vehicle_model: vehicle.model,
      vehicle_year: vehicle.year,
      vehicle_color: vehicle.color,
      pin_notes: c.servicesMentioned.length
        ? `Interested in: ${c.servicesMentioned.join(", ")} (imported)`
        : "Imported pipeline card",
      // Legacy status keeps every existing reader working; the C1 stage
      // column is the new source of truth, linked below.
      status: c.stage === "new" || c.stage === "needs_quote" ? "new" : "quoted",
    })
    .select("id")
    .single()
  if (error || !data) {
    console.error("[recovery] stage-card insert failed:", error)
    return null
  }
  const leadId = (data as { id: string }).id
  // Best-effort — stage/source columns exist only post-C1-migration.
  await supabase
    .from("leads")
    .update({ stage: c.stage, source: c.source ?? "import" })
    .eq("id", leadId)
  return leadId
}

/** C7: unmapped-column notes land on the timeline — never dropped silently. */
async function recordImportNotes(
  supabase: ActionClient,
  shopId: string,
  customerId: string,
  c: ReviewCandidate,
  jobId: string
): Promise<void> {
  if (!c.notes) return
  await recordInteraction(supabase, {
    shopId,
    customerId,
    channel: "note",
    role: "system",
    content: `Imported notes:\n${c.notes}`,
    metadata: { source: "customer_recovery", import_job_id: jobId, kind: "import_notes" },
  })
}

export type UndoRecoveryResult =
  | { ok: true; deleted: number; unmerged: number }
  | { ok: false; error: string }

/**
 * C7 undo: restore the exact pre-import state via provenance —
 *   created customers → deleted (cascades their vehicles/quotes/interactions),
 *   merges → the stored pre-image patch is applied back,
 *   created pipeline cards + import-created vehicle rows → deleted,
 *   the import's own timeline notes → removed.
 * Idempotent: a second run finds nothing to undo.
 */
export async function undoRecoveryImport(
  jobId: string
): Promise<UndoRecoveryResult> {
  if (!FEATURES.customerRecovery) return { ok: false, error: "Not available." }
  const shop = await requireShop()
  const supabase = await createClient()

  const { data: job } = await supabase
    .from("import_jobs")
    .select("id")
    .eq("id", jobId)
    .eq("shop_id", shop.id)
    .maybeSingle()
  if (!job) return { ok: false, error: "Import not found." }

  const { data: trail } = await supabase
    .from("interactions")
    .select("id, customer_id, metadata")
    .eq("shop_id", shop.id)
    .eq("metadata->>import_job_id", jobId)
    .eq("metadata->>source", "customer_recovery")
  const rows =
    (trail as
      | {
          id: string
          customer_id: string | null
          metadata: {
            undo?: {
              kind: "create" | "merge"
              prev?: Record<string, unknown>
              created_lead_id?: string | null
            }
          }
        }[]
      | null) ?? []

  let deleted = 0
  let unmerged = 0

  for (const row of rows) {
    const undo = row.metadata?.undo
    if (!undo || !row.customer_id) continue
    if (undo.created_lead_id) {
      await supabase
        .from("leads")
        .delete()
        .eq("shop_id", shop.id)
        .eq("id", undo.created_lead_id)
    }
    if (undo.kind === "create") {
      const { error } = await supabase
        .from("customers")
        .delete()
        .eq("shop_id", shop.id)
        .eq("id", row.customer_id)
      if (!error) deleted += 1
    } else if (undo.kind === "merge") {
      if (undo.prev && Object.keys(undo.prev).length > 0) {
        await supabase
          .from("customers")
          .update(undo.prev)
          .eq("shop_id", shop.id)
          .eq("id", row.customer_id)
      }
      unmerged += 1
    }
  }

  // Vehicle rows this import created on MERGED customers (created customers'
  // vehicles already cascaded with the delete).
  await supabase
    .from("vehicles")
    .delete()
    .eq("shop_id", shop.id)
    .eq("import_job_id", jobId)

  // Remove the import's own timeline entries last — exact pre-import state.
  await supabase
    .from("interactions")
    .delete()
    .eq("shop_id", shop.id)
    .eq("metadata->>import_job_id", jobId)

  revalidatePath("/recovery")
  revalidatePath("/customers")
  return { ok: true, deleted, unmerged }
}

export type ErrorReportResult =
  | { ok: true; csv: string; dropped: number }
  | { ok: false; error: string }

/** C7: downloadable error report — every dropped row and why. */
export async function getRecoveryErrorReport(
  jobId: string
): Promise<ErrorReportResult> {
  if (!FEATURES.customerRecovery) return { ok: false, error: "Not available." }
  const shop = await requireShop()
  const supabase = await createClient()

  const { data } = await supabase
    .from("import_messages")
    .select("subject, drop_reason")
    .eq("import_job_id", jobId)
    .eq("shop_id", shop.id)
    .eq("kept", false)
  const rows =
    (data as { subject: string | null; drop_reason: string | null }[] | null) ?? []
  return { ok: true, csv: buildErrorReportCsv(rows), dropped: rows.length }
}

export type ImportHistoryEntry = {
  id: string
  source_type: string
  status: string
  counts: Record<string, number>
  created_at: string
}

/** C7: import history — every job the shop has run, newest first. */
export async function listRecoveryImports(): Promise<ImportHistoryEntry[]> {
  if (!FEATURES.customerRecovery) return []
  const shop = await requireShop()
  const supabase = await createClient()
  const { data } = await supabase
    .from("import_jobs")
    .select("id, source_type, status, counts, created_at")
    .eq("shop_id", shop.id)
    .order("created_at", { ascending: false })
    .limit(50)
  return (data as ImportHistoryEntry[] | null) ?? []
}

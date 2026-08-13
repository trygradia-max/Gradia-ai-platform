/**
 * C7 vehicle-cleanup runner — drains the vehicle_needs_llm rows of a
 * structured-CSV import through the Haiku parser, metered per call with the
 * P8 pattern (credit pre-check at the estimating→extracting transition,
 * fail closed, chunked). Composes with runExtraction: after this drains,
 * runExtraction finds nothing left to extract and runs the shared finale
 * (dedupe → status ready).
 *
 * Composed vehicle strings are re-written in canonical "year make model,
 * color" form and vehicle_parsed is stored structurally so the approve path
 * lands exact values in the vehicles table without another regex pass.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import { precheckCredits, recordUsage, type ShopCreditFields } from "@/lib/credits"
import { priceUsage, type Pricing } from "@/lib/pricing"
import { EXTRACTION_SKU } from "@/lib/recovery/estimate"
import type { RecoveryExtraction } from "@/lib/recovery/extract"
import { composeVehicleString } from "@/lib/recovery/structured-csv"
import { parseVehicleWithLlm } from "@/lib/recovery/vehicle-llm"

const MAX_PER_RUN = 40

export type CsvCleanupResult =
  | { ok: false; error: string }
  | { ok: true; cleaned: number; remaining: number }

/**
 * Process up to MAX_PER_RUN pending vehicle cleanups for one job. Call again
 * while remaining > 0 (the extract route loops the same way P8 chunks).
 */
export async function runCsvVehicleCleanup(
  supabase: SupabaseClient,
  shop: ShopCreditFields,
  jobId: string,
  pricing: Pricing
): Promise<CsvCleanupResult> {
  const { data: jobData, error: jobErr } = await supabase
    .from("import_jobs")
    .select("id, shop_id, status, estimated_credits")
    .eq("id", jobId)
    .eq("shop_id", shop.id)
    .maybeSingle()
  const job = jobData as {
    id: string
    status: string
    estimated_credits: number | null
  } | null
  if (jobErr || !job) return { ok: false, error: "Import not found." }
  if (job.status !== "estimating" && job.status !== "extracting") {
    return { ok: false, error: `Import is ${job.status}, not ready to extract.` }
  }

  // Same gate as runExtraction: pre-check + commit once (fail closed).
  if (job.status === "estimating") {
    const precheck = await precheckCredits(supabase, shop, job.estimated_credits ?? 0)
    if (!precheck.ok) return { ok: false, error: precheck.reason }
    await supabase
      .from("import_jobs")
      .update({ status: "extracting", updated_at: new Date().toISOString() })
      .eq("id", jobId)
  }

  const { data: pending } = await supabase
    .from("import_messages")
    .select("id, extraction")
    .eq("import_job_id", jobId)
    .eq("kept", true)
    .eq("extraction->>vehicle_needs_llm", "true")
    .limit(MAX_PER_RUN)
  const batch =
    (pending as { id: string; extraction: RecoveryExtraction }[] | null) ?? []

  const priced = priceUsage(pricing, EXTRACTION_SKU, 1)
  let cleaned = 0
  for (const row of batch) {
    const cell = row.extraction.vehicle ?? ""
    let patch: Partial<RecoveryExtraction>
    try {
      const parsed = await parseVehicleWithLlm(cell)
      // Per-row ref (P0-005 / ADR-001): keyed per cleaned unit so a replay
      // can never double-meter; jobId alone collides within one job.
      await recordUsage(supabase, shop.id, EXTRACTION_SKU, {
        credits: priced.credits,
        wholesaleCost: priced.wholesale_cost,
        retailCost: priced.retail_cost,
        vendorRef: `${jobId}:cleanup:${row.id}`,
      })
      patch = {
        vehicle: composeVehicleString(parsed) ?? row.extraction.vehicle,
        vehicle_parsed: parsed.make || parsed.model || parsed.year || parsed.color ? parsed : null,
        vehicle_needs_llm: false,
      }
    } catch (err) {
      // Keep the raw string; never wedge the import on one bad cell.
      console.error("[csv-cleanup] vehicle parse failed for", row.id, err)
      patch = { vehicle_parsed: null, vehicle_needs_llm: false }
    }
    await supabase
      .from("import_messages")
      .update({ extraction: { ...row.extraction, ...patch } })
      .eq("id", row.id)
    cleaned += 1
  }

  const { count } = await supabase
    .from("import_messages")
    .select("id", { count: "exact", head: true })
    .eq("import_job_id", jobId)
    .eq("kept", true)
    .eq("extraction->>vehicle_needs_llm", "true")

  return { ok: true, cleaned, remaining: count ?? 0 }
}

/**
 * Extraction run for Customer Recovery (P8 / NEXT-3,
 * GRADIA_CUSTOMER_RECOVERY_SPEC §2). The owner has seen the estimate and
 * confirmed; this spends credits. It pre-checks the estimate (fail closed),
 * runs the Haiku worker over each kept staged unit, meters every call, and —
 * once the whole job is extracted — dedupes the confident candidates against
 * the CRM and purges the raw bodies (retention).
 *
 * Chunked: each call processes up to MAX_PER_RUN un-extracted units so a large
 * import drains across several requests without blowing the function timeout.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import { precheckCredits, recordUsage, type ShopCreditFields } from "@/lib/credits"
import { priceUsage, type Pricing } from "@/lib/pricing"
import { buildCandidates, type ExtractedRow } from "@/lib/recovery/candidates"
import {
  resolveImportSet,
  type ExistingCustomer,
  type ResolvedCandidate,
} from "@/lib/recovery/dedupe"
import {
  extractCustomerFromThread,
  type RecoveryExtraction,
} from "@/lib/recovery/extract"
import { deleteJobBodies, loadBody } from "@/lib/recovery/storage"

const MAX_PER_RUN = 40
const EXTRACTION_SKU = "outreach_draft" as const

/** Placeholder extraction for a unit whose body couldn't be read — confidence 0
 *  so it's dropped by the candidate gate and never retried (extraction is set). */
const UNREADABLE: RecoveryExtraction = {
  name: null,
  phones: [],
  emails: [],
  vehicle: null,
  services_mentioned: [],
  last_interaction_at: null,
  direction: "inquiry",
  confidence: 0,
}

export type ExtractRunResult =
  | { ok: false; error: string }
  | {
      ok: true
      jobId: string
      extracted: number
      remaining: number
      done: boolean
      candidates: ResolvedCandidate<string>[]
    }

type JobRow = {
  id: string
  shop_id: string
  status: string
  estimated_credits: number | null
}

export async function runExtraction(
  supabase: SupabaseClient,
  shop: ShopCreditFields,
  jobId: string,
  pricing: Pricing
): Promise<ExtractRunResult> {
  const { data: jobData, error: jobErr } = await supabase
    .from("import_jobs")
    .select("id, shop_id, status, estimated_credits")
    .eq("id", jobId)
    .eq("shop_id", shop.id)
    .maybeSingle()
  const job = jobData as JobRow | null
  if (jobErr || !job) return { ok: false, error: "Import not found." }
  if (job.status !== "estimating" && job.status !== "extracting") {
    return { ok: false, error: `Import is ${job.status}, not ready to extract.` }
  }

  // Pre-check + commit happens once, at the estimating → extracting transition.
  if (job.status === "estimating") {
    const precheck = await precheckCredits(
      supabase,
      shop,
      job.estimated_credits ?? 0
    )
    if (!precheck.ok) return { ok: false, error: precheck.reason }
    await supabase
      .from("import_jobs")
      .update({ status: "extracting", updated_at: new Date().toISOString() })
      .eq("id", jobId)
  }

  // Pull the next chunk of kept, not-yet-extracted units.
  const { data: pending } = await supabase
    .from("import_messages")
    .select("id, body_ref")
    .eq("import_job_id", jobId)
    .eq("kept", true)
    .is("extraction", null)
    .limit(MAX_PER_RUN)
  const batch = (pending as { id: string; body_ref: string | null }[] | null) ?? []

  const priced = priceUsage(pricing, EXTRACTION_SKU, 1)
  let extracted = 0
  for (const row of batch) {
    const body = row.body_ref ? await loadBody(supabase, row.body_ref) : null
    let extraction: RecoveryExtraction
    if (!body) {
      extraction = UNREADABLE
    } else {
      try {
        extraction = await extractCustomerFromThread(body)
        await recordUsage(supabase, shop.id, EXTRACTION_SKU, {
          credits: priced.credits,
          wholesaleCost: priced.wholesale_cost,
          retailCost: priced.retail_cost,
          vendorRef: jobId,
        })
      } catch (err) {
        console.error("[recovery] extraction failed for", row.id, err)
        extraction = UNREADABLE
      }
    }
    await supabase
      .from("import_messages")
      .update({ extraction })
      .eq("id", row.id)
    extracted += 1
  }

  // How many kept units still need extraction?
  const { count: remainingCount } = await supabase
    .from("import_messages")
    .select("id", { count: "exact", head: true })
    .eq("import_job_id", jobId)
    .eq("kept", true)
    .is("extraction", null)
  const remaining = remainingCount ?? 0

  if (remaining > 0) {
    return { ok: true, jobId, extracted, remaining, done: false, candidates: [] }
  }

  // Whole job extracted → dedupe the confident candidates against the CRM.
  const { data: doneRows } = await supabase
    .from("import_messages")
    .select("id, extraction")
    .eq("import_job_id", jobId)
    .eq("kept", true)
    .not("extraction", "is", null)
  const rows = (doneRows as { id: string; extraction: RecoveryExtraction }[] | null) ?? []
  const candidatesIn = buildCandidates(rows as ExtractedRow[])

  const { data: custRows } = await supabase
    .from("customers")
    .select("id, name, phone, email")
    .eq("shop_id", shop.id)
  const existing = (custRows as ExistingCustomer[] | null) ?? []

  const candidates = resolveImportSet(candidatesIn, existing)

  await supabase
    .from("import_jobs")
    .update({ status: "ready", updated_at: new Date().toISOString() })
    .eq("id", jobId)

  // Retention: the raw bodies have served their purpose — purge them.
  await deleteJobBodies(supabase, shop.id, jobId)

  return { ok: true, jobId, extracted, remaining: 0, done: true, candidates }
}

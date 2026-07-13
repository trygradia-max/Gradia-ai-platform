/**
 * Review-queue read + shaping for Customer Recovery (P8 / NEXT-3,
 * GRADIA_CUSTOMER_RECOVERY_SPEC §3.1). Recomputes the deduped candidates from
 * the job's PERSISTED extractions (so the review page is reloadable after the
 * run), and shapes each into a reviewable record the owner can approve.
 *
 * The shaping helpers are pure so the customer-write payload is unit-tested.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import { parseVehicle, type ParsedVehicle } from "@/lib/vehicle"
import { buildCandidates, type ExtractedRow } from "@/lib/recovery/candidates"
import type { CrmStage } from "@/lib/types/database"
import {
  resolveImportSet,
  type ExistingCustomer,
  type MatchDecision,
} from "@/lib/recovery/dedupe"
import type { RecoveryExtraction } from "@/lib/recovery/extract"

/** A candidate as the review queue shows it — the merged contact facts + how it
 *  matched the CRM, ready for one-tap approve. */
export type ReviewCandidate = {
  /** Stable key (the first member's staging-row id). */
  key: string
  decision: MatchDecision
  name: string | null
  phones: string[]
  emails: string[]
  vehicle: string | null
  /** C7: structured vehicle from mapped columns / LLM cleanup, when present. */
  vehicleParsed: ParsedVehicle | null
  /** C7: mapped pipeline stage + lead source + unmapped-column notes. */
  stage: CrmStage | null
  source: string | null
  notes: string | null
  lastTransactionAt: string | null
  servicesMentioned: string[]
  memberIds: string[]
  nameConflict: boolean
}

function laterIso(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return Date.parse(a) >= Date.parse(b) ? a : b
}

/** Merge the extractions backing a deduped group into one reviewable record. */
export function shapeReviewCandidate(
  group: { names: string[]; phones: string[]; emails: string[]; members: string[]; nameConflict: boolean },
  decision: MatchDecision,
  extractionById: Map<string, RecoveryExtraction>
): ReviewCandidate {
  const exts = group.members
    .map((id) => extractionById.get(id))
    .filter((e): e is RecoveryExtraction => Boolean(e))

  const vehicle = exts.map((e) => e.vehicle).find(Boolean) ?? null
  const vehicleParsed =
    exts.map((e) => e.vehicle_parsed).find((v): v is ParsedVehicle => Boolean(v?.make || v?.model)) ??
    null
  const stage = exts.map((e) => e.stage).find(Boolean) ?? null
  const source = exts.map((e) => e.source).find(Boolean) ?? null
  const notes = exts.map((e) => e.notes).filter(Boolean).join("\n") || null
  const lastTransactionAt = exts.reduce<string | null>(
    (acc, e) => laterIso(acc, e.last_interaction_at),
    null
  )
  const services = [...new Set(exts.flatMap((e) => e.services_mentioned))]

  return {
    key: group.members[0],
    decision,
    name: group.names[0] ?? null,
    phones: group.phones,
    emails: group.emails,
    vehicle,
    vehicleParsed,
    stage,
    source,
    notes,
    lastTransactionAt,
    servicesMentioned: services,
    memberIds: group.members,
    nameConflict: group.nameConflict,
  }
}

/** The customer columns written when a candidate is approved into the CRM.
 *  The flat vehicle_* fields are write-through-deprecated (lib/vehicles.ts);
 *  the vehicles-table row rides separately via candidateVehicle. */
export type RecoveredCustomerInput = {
  name: string | null
  phone: string | null
  email: string | null
  vehicle_make: string | null
  vehicle_model: string | null
  vehicle_year: number | null
  vehicle_color: string | null
  source: "import"
  last_transaction_at: string | null
}

/** Pure: turn an approved candidate into the customer insert payload. */
export function candidateToCustomerInput(
  c: Pick<ReviewCandidate, "name" | "phones" | "emails" | "vehicle" | "lastTransactionAt">
): RecoveredCustomerInput {
  const v = parseVehicle(c.vehicle)
  return {
    name: c.name,
    phone: c.phones[0] ?? null,
    email: c.emails[0] ?? null,
    vehicle_make: v.make,
    vehicle_model: v.model,
    vehicle_year: v.year,
    vehicle_color: v.color,
    source: "import",
    last_transaction_at: c.lastTransactionAt,
  }
}

/** Pure: the candidate's parsed vehicle, for the `vehicles` upsert (C1).
 *  Prefers the C7 structured parse (owner columns / LLM cleanup — no MAKES
 *  whitelist limit); the regex is the mbox/contacts fallback. */
export function candidateVehicle(
  c: Pick<ReviewCandidate, "vehicle"> & Partial<Pick<ReviewCandidate, "vehicleParsed">>
): ParsedVehicle {
  if (c.vehicleParsed && (c.vehicleParsed.make || c.vehicleParsed.model)) {
    return c.vehicleParsed
  }
  return parseVehicle(c.vehicle)
}

/**
 * Pure: build the patch for a merge_into approval — fill only EMPTY fields on
 * the existing customer (never overwrite the owner's data), advance
 * last_transaction_at to the later date, and stamp source if it was blank.
 * Flat vehicle_* fills are write-through (deprecated); the vehicles-table
 * row is upserted separately by the approval action.
 */
export function mergePatch(
  existing: {
    name: string | null
    phone: string | null
    email: string | null
    vehicle_make: string | null
    vehicle_model: string | null
    vehicle_year: number | null
    vehicle_color: string | null
    last_transaction_at: string | null
    source: string | null
  },
  input: RecoveredCustomerInput
): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  const fillIfEmpty = (key: keyof typeof existing, value: unknown) => {
    if ((existing[key] === null || existing[key] === undefined) && value != null) {
      patch[key] = value
    }
  }
  fillIfEmpty("name", input.name)
  fillIfEmpty("phone", input.phone)
  fillIfEmpty("email", input.email)
  fillIfEmpty("vehicle_make", input.vehicle_make)
  fillIfEmpty("vehicle_model", input.vehicle_model)
  fillIfEmpty("vehicle_year", input.vehicle_year)
  fillIfEmpty("vehicle_color", input.vehicle_color)
  if (!existing.source) patch.source = input.source
  const later = laterIso(existing.last_transaction_at, input.last_transaction_at)
  if (later && later !== existing.last_transaction_at) {
    patch.last_transaction_at = later
  }
  return patch
}

/**
 * Pure: the pre-image needed to undo a merge patch — the customer's prior
 * value for every key the patch will overwrite (all were empty/null by
 * mergePatch's fill-only rule, but capture faithfully anyway). Stored in the
 * approval's timeline-interaction metadata; undoRecoveryImport applies it
 * back verbatim (C7 undo — restores exact pre-import state).
 */
export function buildMergeUndo(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const prev: Record<string, unknown> = {}
  for (const key of Object.keys(patch)) {
    prev[key] = existing[key] ?? null
  }
  return prev
}

/** Pure: CSV error report of dropped rows (downloadable from the wizard). */
export function buildErrorReportCsv(
  rows: { subject: string | null; drop_reason: string | null }[]
): string {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  const lines = ["row,reason"]
  for (const r of rows) {
    lines.push(`${esc(r.subject ?? "(unnamed row)")},${esc(r.drop_reason ?? "unknown")}`)
  }
  return lines.join("\n")
}

export type JobCandidates = {
  status: string
  counts: Record<string, number>
  estimatedCredits: number | null
  candidates: ReviewCandidate[]
}

/** Load a job + recompute its review candidates from persisted extractions. */
export async function loadJobCandidates(
  supabase: SupabaseClient,
  shopId: string,
  jobId: string
): Promise<JobCandidates | null> {
  const { data: jobData } = await supabase
    .from("import_jobs")
    .select("id, status, counts, estimated_credits")
    .eq("id", jobId)
    .eq("shop_id", shopId)
    .maybeSingle()
  const job = jobData as
    | { status: string; counts: Record<string, number>; estimated_credits: number | null }
    | null
  if (!job) return null

  const { data: rowData } = await supabase
    .from("import_messages")
    .select("id, extraction")
    .eq("import_job_id", jobId)
    .eq("kept", true)
    .not("extraction", "is", null)
  const rows = (rowData as { id: string; extraction: RecoveryExtraction }[] | null) ?? []

  const extractionById = new Map(rows.map((r) => [r.id, r.extraction]))
  const candidatesIn = buildCandidates(rows as ExtractedRow[])

  const { data: custData } = await supabase
    .from("customers")
    .select("id, name, phone, email")
    .eq("shop_id", shopId)
  const existing = (custData as ExistingCustomer[] | null) ?? []

  const resolved = resolveImportSet(candidatesIn, existing)
  const candidates = resolved.map((r) =>
    shapeReviewCandidate(r.group, r.decision, extractionById)
  )

  return {
    status: job.status,
    counts: job.counts ?? {},
    estimatedCredits: job.estimated_credits,
    candidates,
  }
}

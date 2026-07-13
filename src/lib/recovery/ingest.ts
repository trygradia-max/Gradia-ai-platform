/**
 * Ingestion orchestrator for Customer Recovery (P8 / NEXT-3,
 * GRADIA_CUSTOMER_RECOVERY_SPEC §1). Turns an uploaded file into staged,
 * pre-filtered units ready for extraction, and computes the pre-run estimate
 * the owner approves before any LLM spend. Runs under the service role.
 *
 * It does NOT call the LLM — that's runExtraction, gated behind the owner's
 * confirmation of the estimate.
 */

import { randomUUID } from "node:crypto"

import type { SupabaseClient } from "@supabase/supabase-js"

import { contactToText } from "@/lib/recovery/candidates"
import {
  estimateExtractionCredits,
  type ExtractionEstimate,
} from "@/lib/recovery/estimate"
import {
  buildThreads,
  parseMboxMessages,
} from "@/lib/recovery/parse-mbox"
import {
  parseContactsCsv,
  parseVcard,
} from "@/lib/recovery/parse-contacts"
import { prefilterThreads } from "@/lib/recovery/prefilter"
import { bodyPath, storeBody } from "@/lib/recovery/storage"
import {
  applyMapping,
  autoMapColumns,
  detectHeaderRow,
  extractionNeedsVehicleLlm,
  parseCsv,
  recordToExtraction,
  type CsvMapping,
} from "@/lib/recovery/structured-csv"
import type { RecoveryExtraction } from "@/lib/recovery/extract"
import type { Pricing } from "@/lib/pricing"
import type { ImportSourceType } from "@/lib/types/database"

/** A normalized unit ready to stage — a kept thread/contact gets a body stored.
 *  C7 structured-CSV units arrive with a DETERMINISTIC extraction already set
 *  (no body, no LLM); only vehicle_needs_llm rows cost credits later. */
export type StagedUnit = {
  messageId: string | null
  fromEmail: string | null
  subject: string | null
  hasListUnsubscribe: boolean
  ownerParticipated: boolean
  body: string
  keep: boolean
  dropReason: string | null
  extraction?: RecoveryExtraction | null
}

export type IngestInput = {
  sourceType: ImportSourceType
  fileContent: string
  /** Shop's own addresses — used to detect owner participation in mbox threads. */
  ownerEmails: string[]
  pricing: Pricing
  /** C7: owner-confirmed column mapping; auto-mapped when omitted. */
  csvMapping?: CsvMapping | null
}

export type IngestResult = {
  jobId: string
  counts: { total: number; kept: number; dropped: number }
  estimate: ExtractionEstimate
}

/**
 * Parse + pre-filter a file into staged units. Pure (no DB / storage) so the
 * branching per source type and the prefilter wiring are unit-tested.
 *   - mbox: messages → threads → pre-filter (drops bulk/no-reply/no-participation)
 *   - contacts (CSV/vCard): each card is a person; rendered to text, kept (the
 *     confidence gate at extraction drops vendor entries in the address book)
 */
export function buildUnits(input: IngestInput): StagedUnit[] {
  if (input.sourceType === "mbox") {
    const threads = buildThreads(
      parseMboxMessages(input.fileContent),
      input.ownerEmails
    )
    const { kept, dropped } = prefilterThreads(threads)
    return [
      ...kept.map((t) => ({
        messageId: t.messageId,
        fromEmail: t.fromEmail || null,
        subject: t.subject || null,
        hasListUnsubscribe: t.hasListUnsubscribe,
        ownerParticipated: t.ownerParticipated,
        body: t.body,
        keep: true,
        dropReason: null,
      })),
      ...dropped.map(({ thread, reason }) => ({
        messageId: thread.messageId,
        fromEmail: thread.fromEmail || null,
        subject: thread.subject || null,
        hasListUnsubscribe: thread.hasListUnsubscribe,
        ownerParticipated: thread.ownerParticipated,
        body: "", // dropped units never store a body (PII minimization)
        keep: false,
        dropReason: reason,
      })),
    ]
  }

  // C7 structured CSV: the mapping IS the extraction — deterministic, no
  // body stored (the spreadsheet cells are already structured; nothing for
  // an LLM to read except an unparseable vehicle string, patched later).
  if (input.sourceType === "structured_csv") {
    const rows = parseCsv(input.fileContent)
    const mapping =
      input.csvMapping ?? autoMapColumns(rows, detectHeaderRow(rows))
    return applyMapping(rows, mapping).map((rec) => {
      const reachable = rec.phones.length > 0 || rec.emails.length > 0
      return {
        messageId: null,
        fromEmail: rec.emails[0] ?? null,
        subject: rec.name ?? `Row ${rec.rowIndex + 1}`,
        hasListUnsubscribe: false,
        ownerParticipated: true,
        body: "",
        keep: reachable,
        dropReason: reachable ? null : "no contact info",
        extraction: reachable ? recordToExtraction(rec) : null,
      }
    })
  }

  // Contacts: CSV or vCard.
  const contacts =
    input.sourceType === "contacts_csv"
      ? parseContactsCsv(input.fileContent)
      : parseVcard(input.fileContent)
  return contacts.map((c) => ({
    messageId: null,
    fromEmail: c.emails[0] ?? null,
    subject: c.name ?? "Contact",
    hasListUnsubscribe: false,
    ownerParticipated: true,
    body: contactToText(c),
    keep: true,
    dropReason: null,
  }))
}

/** Kept units that will actually hit the LLM — mbox/contacts always do;
 *  structured-CSV rows only when their vehicle string defeated the regex. */
export function countLlmUnits(units: StagedUnit[]): number {
  return units.filter(
    (u) =>
      u.keep &&
      (u.extraction == null || extractionNeedsVehicleLlm(u.extraction))
  ).length
}

export async function ingestImport(
  supabase: SupabaseClient,
  shopId: string,
  input: IngestInput
): Promise<IngestResult> {
  const { data: job, error: jobErr } = await supabase
    .from("import_jobs")
    .insert({ shop_id: shopId, source_type: input.sourceType, status: "parsing" })
    .select("id")
    .single()
  if (jobErr || !job) {
    throw new Error(`Couldn't start the import: ${jobErr?.message ?? "no job"}`)
  }
  const jobId = (job as { id: string }).id

  try {
    const units = buildUnits(input)

    // Stage every unit (kept + dropped). Kept units get a stored body the
    // extraction step reads; dropped units keep only their drop_reason.
    const staged = units.map((u) => {
      const id = randomUUID()
      return {
        unit: u,
        row: {
          id,
          import_job_id: jobId,
          shop_id: shopId,
          message_id: u.messageId,
          from_email: u.fromEmail,
          subject: u.subject,
          // Pre-extracted units (structured CSV) never store a body.
          body_ref: u.keep && u.body ? bodyPath(shopId, jobId, id) : null,
          has_list_unsubscribe: u.hasListUnsubscribe,
          owner_participated: u.ownerParticipated,
          kept: u.keep,
          drop_reason: u.dropReason,
          extraction: u.extraction ?? null,
        },
      }
    })

    if (staged.length > 0) {
      const { error: insErr } = await supabase
        .from("import_messages")
        .insert(staged.map((s) => s.row))
      if (insErr) throw new Error(`Staging failed: ${insErr.message}`)
    }

    // Store kept bodies in the private bucket.
    for (const s of staged) {
      if (s.unit.keep && s.row.body_ref) {
        await storeBody(supabase, s.row.body_ref, s.unit.body)
      }
    }

    const keptCount = units.filter((u) => u.keep).length
    const counts = {
      total: units.length,
      kept: keptCount,
      dropped: units.length - keptCount,
    }
    // Estimate prices only the units that will hit the LLM — a structured
    // CSV is mostly deterministic, so this is usually a handful of rows.
    const estimate = estimateExtractionCredits(countLlmUnits(units), input.pricing)

    await supabase
      .from("import_jobs")
      .update({
        status: "estimating", // estimate ready — awaiting owner confirmation
        counts,
        estimated_credits: estimate.credits,
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId)

    return { jobId, counts, estimate }
  } catch (err) {
    await supabase
      .from("import_jobs")
      .update({
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId)
    throw err
  }
}

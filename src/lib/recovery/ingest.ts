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
import type { Pricing } from "@/lib/pricing"
import type { ImportSourceType } from "@/lib/types/database"

/** A normalized unit ready to stage — a kept thread/contact gets a body stored. */
export type StagedUnit = {
  messageId: string | null
  fromEmail: string | null
  subject: string | null
  hasListUnsubscribe: boolean
  ownerParticipated: boolean
  body: string
  keep: boolean
  dropReason: string | null
}

export type IngestInput = {
  sourceType: ImportSourceType
  fileContent: string
  /** Shop's own addresses — used to detect owner participation in mbox threads. */
  ownerEmails: string[]
  pricing: Pricing
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
          body_ref: u.keep ? bodyPath(shopId, jobId, id) : null,
          has_list_unsubscribe: u.hasListUnsubscribe,
          owner_participated: u.ownerParticipated,
          kept: u.keep,
          drop_reason: u.dropReason,
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
    const estimate = estimateExtractionCredits(keptCount, input.pricing)

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

/**
 * Pure helpers bridging extraction → dedupe for Customer Recovery (P8 /
 * NEXT-3). Kept separate from the DB orchestrator so the confidence gate and
 * the candidate-shaping are unit-tested without a model or database.
 */

import type { ContactRecord } from "@/lib/recovery/parse-contacts"
import type { ImportCandidate } from "@/lib/recovery/dedupe"
import type { RecoveryExtraction } from "@/lib/recovery/extract"

/**
 * Below this, a row is treated as non-customer noise (vendor/spam/cold
 * outreach that slipped the pre-filter) and dropped before it can reach the
 * CRM. Mirrors the worker's guidance that real customers score ≥ 0.7 and
 * spam ≤ 0.2 — 0.5 is the conservative midline.
 */
export const CONFIDENCE_THRESHOLD = 0.5

/** Render a parsed contact card as text the extraction worker can read. */
export function contactToText(c: ContactRecord): string {
  const lines = ["Contact card:"]
  if (c.name) lines.push(`Name: ${c.name}`)
  if (c.phones.length) lines.push(`Phones: ${c.phones.join(", ")}`)
  if (c.emails.length) lines.push(`Emails: ${c.emails.join(", ")}`)
  return lines.join("\n")
}

/** One staged row carrying its extraction + the provenance id to thread through. */
export type ExtractedRow = {
  id: string
  extraction: RecoveryExtraction
}

/**
 * Keep only confident extractions that carry at least one contact identifier,
 * and shape them into dedupe candidates whose provenance is the staging-row id.
 * A confident extraction with no phone AND no email is unreachable, so it's
 * dropped too.
 */
export function buildCandidates(
  rows: ExtractedRow[]
): ImportCandidate<string>[] {
  const candidates: ImportCandidate<string>[] = []
  for (const row of rows) {
    const e = row.extraction
    if (e.confidence < CONFIDENCE_THRESHOLD) continue
    if (e.phones.length === 0 && e.emails.length === 0) continue
    candidates.push({
      name: e.name,
      phones: e.phones,
      emails: e.emails,
      provenance: row.id,
    })
  }
  return candidates
}

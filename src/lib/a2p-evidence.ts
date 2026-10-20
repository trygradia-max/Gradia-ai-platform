/**
 * Carrier-approval evidence for a Gradia number (October 20 evidence policy).
 *
 * Evidence is a successful provider read of the campaign that returned
 * VERIFIED, stamped by the database as shops.a2p_verified_at. The send gate
 * opens a Gradia number only while a2p_status is 'approved' AND that evidence
 * is younger than the maximum age. A missing or unreadable time is stale. A
 * failed refresh never renews it, so during a provider outage the status stays
 * 'approved' while the evidence ages, and the gate then closes as "check
 * overdue" (not 'suspended').
 *
 * Pure: no server imports, so readiness code can share it.
 */

/** Default maximum evidence age. The release lane should confirm this number. */
export const A2P_EVIDENCE_DEFAULT_MAX_AGE_HOURS = 72
/** Hard ceiling: configuration can shorten the age, never extend it past this. */
export const A2P_EVIDENCE_CEILING_HOURS = 7 * 24
/** Tolerated clock difference between the database and this server. */
const CLOCK_SKEW_MS = 5 * 60_000

type Env = Record<string, string | undefined>

/**
 * The maximum evidence age in hours: A2P_EVIDENCE_MAX_AGE_HOURS when it is a
 * positive number, capped at the ceiling; otherwise the default.
 */
export function a2pEvidenceMaxAgeHours(env: Env = process.env): number {
  const raw = Number(env.A2P_EVIDENCE_MAX_AGE_HOURS?.trim())
  if (!Number.isFinite(raw) || raw <= 0) return A2P_EVIDENCE_DEFAULT_MAX_AGE_HOURS
  return Math.min(raw, A2P_EVIDENCE_CEILING_HOURS)
}

/** Whether a VERIFIED time is recent enough to keep texting open. */
export function a2pEvidenceFresh(verifiedAt: string | null | undefined, now: Date = new Date(), env: Env = process.env): boolean {
  if (!verifiedAt) return false
  const at = Date.parse(verifiedAt)
  if (!Number.isFinite(at)) return false
  const age = now.getTime() - at
  return age >= -CLOCK_SKEW_MS && age <= a2pEvidenceMaxAgeHours(env) * 3_600_000
}

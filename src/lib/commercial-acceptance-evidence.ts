import { z } from "zod"

import {
  AUTOMATED_STEPS,
  MANUAL_STEPS,
  TEST_CLOCK_EVIDENCE_VERSION,
  currentContractFingerprint,
  type ManualStep,
} from "@/lib/stripe-test-clock-acceptance"

/**
 * Judges a real Stripe TEST-clock evidence record (PR F2). Pure. The record is operator evidence produced by
 * `npm run billing:test-clock-acceptance`; it is NOT a cryptographic proof (a human could edit a file), so it is
 * validated strictly: exact schema, finite step ids, current contract fingerprint, freshness, and the absence of anything
 * id-, URL- or secret-shaped. Manual steps (hosted Checkout, Stripe-delivered webhook) are never in the file as passed:
 * only an explicit operator attestation at report time satisfies them, and the report says so.
 */

export const EVIDENCE_MAX_AGE_DAYS = 30

export type EvidenceFindingCode =
  | "real_stripe_acceptance_not_run"
  | "real_evidence_invalid"
  | "real_evidence_forbidden_content"
  | "real_evidence_contract_changed"
  | "real_evidence_stale"
  | "real_evidence_not_passed"
  | "real_evidence_cleanup_failed"
  | `real_evidence_step_${string}`
  | `manual_step_unattested_${ManualStep}`

export type RealAcceptanceStatus = "NOT RUN" | "PASSED" | "FAILED" | "INCOMPLETE" | "STALE" | "INVALID" | "CONTRACT CHANGED"

export type EvidenceJudgement = { status: RealAcceptanceStatus; findings: EvidenceFindingCode[]; attested: ManualStep[] }

const stepIds = [...AUTOMATED_STEPS, ...MANUAL_STEPS] as [string, ...string[]]
const evidenceSchema = z
  .object({
    version: z.literal(TEST_CLOCK_EVIDENCE_VERSION),
    mode: z.literal("test"),
    contractVersion: z.string().max(80),
    itemSetDigest: z.string().regex(/^[0-9a-f]{64}$/),
    meterApiVersion: z.string().max(40),
    mappingVersion: z.string().max(80),
    completedAt: z.string().max(40),
    overall: z.enum(["PASSED", "FAILED", "INCOMPLETE", "REFUSED"]),
    steps: z
      .array(
        z
          .object({
            id: z.enum(stepIds),
            status: z.enum(["PASS", "FAIL", "NOT_RUN", "OBSERVED", "MANUAL"]),
            code: z.string().regex(/^[a-z0-9_]{1,63}$/).nullable(),
            numbers: z.record(z.string().regex(/^[A-Za-z]{1,40}$/), z.number().int()).optional(),
          })
          .strict()
      )
      .max(40),
    cleanup: z.enum(["deleted", "failed", "not_needed"]),
    limitations: z.array(z.string().max(600)).max(12),
  })
  .strict()

/** Nothing id-, URL- or secret-shaped may sit in an evidence file. */
const FORBIDDEN = /\b(cus|sub|in|cs_test|clock|price|prod|mtr|pm|evt|si|bps|ii|acct)_[A-Za-z0-9]{6,}|whsec_|(sk|rk|pk)_(test|live)_|https?:\/\/|"livemode"\s*:\s*true/

export function evaluateAcceptanceEvidence(
  raw: unknown,
  options: { nowMs?: number; attested?: readonly string[] } = {}
): EvidenceJudgement {
  const attested = MANUAL_STEPS.filter((id) => (options.attested ?? []).includes(id))
  if (raw === null || raw === undefined) return { status: "NOT RUN", findings: ["real_stripe_acceptance_not_run"], attested }
  let text = ""
  try {
    text = JSON.stringify(raw)
  } catch {
    return { status: "INVALID", findings: ["real_evidence_invalid"], attested }
  }
  if (FORBIDDEN.test(text)) return { status: "INVALID", findings: ["real_evidence_forbidden_content"], attested }
  const parsed = evidenceSchema.safeParse(raw)
  if (!parsed.success) return { status: "INVALID", findings: ["real_evidence_invalid"], attested }
  const evidence = parsed.data

  const findings: EvidenceFindingCode[] = []
  const current = currentContractFingerprint()
  if (
    evidence.contractVersion !== current.contractVersion ||
    evidence.itemSetDigest !== current.itemSetDigest ||
    evidence.meterApiVersion !== current.meterApiVersion ||
    evidence.mappingVersion !== current.mappingVersion
  ) {
    return { status: "CONTRACT CHANGED", findings: ["real_evidence_contract_changed"], attested }
  }
  const completed = Date.parse(evidence.completedAt)
  const now = options.nowMs ?? Date.now()
  if (!Number.isFinite(completed) || completed > now + 5 * 60_000 || now - completed > EVIDENCE_MAX_AGE_DAYS * 86_400_000) {
    return { status: "STALE", findings: ["real_evidence_stale"], attested }
  }

  for (const id of AUTOMATED_STEPS) {
    const found = evidence.steps.filter((s) => s.id === id)
    const ok = found.length === 1 && (found[0].status === "PASS" || found[0].status === "OBSERVED")
    if (!ok) findings.push(`real_evidence_step_${id}`)
  }
  if (evidence.cleanup === "failed") findings.push("real_evidence_cleanup_failed")
  if (evidence.overall !== "PASSED") findings.push("real_evidence_not_passed")
  for (const id of MANUAL_STEPS) if (!attested.includes(id)) findings.push(`manual_step_unattested_${id}`)

  const automatedBad = findings.some((f) => f.startsWith("real_evidence_"))
  const status: RealAcceptanceStatus = !automatedBad
    ? "PASSED"
    : evidence.overall === "FAILED" || evidence.steps.some((s) => s.status === "FAIL")
      ? "FAILED"
      : "INCOMPLETE"
  return { status, findings, attested }
}

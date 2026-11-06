/**
 * Deterministic daily extra-operator seat proration (Commercial Billing PR B).
 *
 * Pure: no clock, no database, no Stripe. Input is the immutable membership
 * billing evidence recorded by the database (see
 * supabase/migrations/20261104140000_membership_billing_history.sql).
 *
 * Rules (founder-approved catalog 2026-11-03.v1):
 *  - a billable operator is an ACTIVE owner, manager or staff member;
 *  - distinct USERS are counted, never membership rows;
 *  - a user active at ANY instant of a UTC calendar day consumes exactly one
 *    seat-day for that day;
 *  - per day, extra seats = max(distinct billable users - included seats, 0);
 *  - the period charge is (sum of extra seat-days) x extra-seat price / days in
 *    the period, rounded ONCE half-up to the nearest cent.
 *
 * It never reconstructs history. If any part of the period is not covered by
 * recorded evidence — or the period is not yet closed — the result is
 * `seat_proration_unavailable` with the exact gap, never zero.
 */

export type MembershipEvidenceEvent = {
  id: string
  /** Gapless per-shop order; breaks ties between events at the same instant. */
  shopSeq: number
  userId: string
  kind: string
  newBillable: boolean
  effectiveAt: string
  recordedAt: string
}

export type MembershipEvidenceCoverage = {
  coveredFrom: string
  basis: string
  recordedAt: string
}

export type MembershipEvidence = {
  status: "evidence"
  coverage: MembershipEvidenceCoverage | null
  events: readonly MembershipEvidenceEvent[]
}

/** The caller could not obtain evidence at all (read failed, forbidden, malformed). */
export type MembershipEvidenceUnavailable = {
  status: "unavailable"
  code: "membership_read_failed" | "malformed_membership_evidence"
}

export type SeatProrationUnavailableCode =
  | "no_membership_evidence"
  | "membership_read_failed"
  | "malformed_membership_evidence"
  | "invalid_period"
  | "period_not_utc_day_aligned"
  | "no_coverage"
  | "coverage_gap"
  | "period_not_closed"

export type SeatProration =
  | {
      state: "computed"
      periodStart: string
      periodEnd: string
      daysInPeriod: number
      includedSeats: number
      extraSeatCents: number
      /** Sum over days of max(distinct billable users - included, 0). */
      extraSeatDays: number
      /** Exact charge = numerator / denominator cents; `roundedCents` is rounded once, half-up. */
      numerator: number
      denominator: number
      roundedCents: number
      coveredFrom: string
      days: { date: string; billableUsers: number; extraSeats: number }[]
      evidenceEventIds: string[]
    }
  | {
      state: "seat_proration_unavailable"
      code: SeatProrationUnavailableCode
      reason: string
      /** The exact uncovered or not-yet-closed span, when there is one. */
      gap?: { start: string; end: string }
    }

export type SeatProrationInput = {
  includedSeats: number
  extraSeatCents: number
  /** Half-open UTC billing period [periodStart, periodEnd), midnight to midnight. */
  periodStart: string
  periodEnd: string
  /** Only evidence recorded at or before this instant exists. */
  asOf: string
  evidence: MembershipEvidence | MembershipEvidenceUnavailable | undefined
}

const DAY_MS = 86_400_000
const MAX_PERIOD_DAYS = 40
const TS =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/

/** Exact microseconds since the epoch, so same-millisecond events keep their order. */
export function parseMicros(value: string): bigint | null {
  const match = TS.exec(value)
  if (!match) return null
  const zone = match[3] === "Z" ? "Z" : match[3].length === 3 ? `${match[3]}:00` : match[3].replace(/^([+-]\d{2})(\d{2})$/, "$1:$2")
  const seconds = Date.parse(`${match[1]}${zone}`)
  if (Number.isNaN(seconds)) return null
  return BigInt(seconds) * BigInt(1000) + BigInt((match[2] ?? "").padEnd(6, "0"))
}

const isoOf = (micros: bigint) => new Date(Number(micros / BigInt(1000))).toISOString()

const REASONS: Record<SeatProrationUnavailableCode, string> = {
  no_membership_evidence:
    "Daily seat proration needs immutable billable-membership interval evidence, which was not provided; the current member count is not historical truth.",
  membership_read_failed: "Membership billing evidence could not be read.",
  malformed_membership_evidence: "Membership billing evidence was malformed and was not used.",
  invalid_period: "The billing period is not a valid UTC window.",
  period_not_utc_day_aligned:
    "Seat proration is calendar-day based; the billing period must start and end at UTC midnight.",
  no_coverage: "No explicit membership coverage has been recorded for this shop.",
  coverage_gap:
    "Part of the period is before recorded membership coverage; history is never reconstructed from current state.",
  period_not_closed:
    "The billing period has not closed as of the evidence instant, so later membership changes are not yet known.",
}

function unavailable(
  code: SeatProrationUnavailableCode,
  gap?: { start: string; end: string }
): SeatProration {
  return { state: "seat_proration_unavailable", code, reason: REASONS[code], ...(gap ? { gap } : {}) }
}

export function computeSeatProration(input: SeatProrationInput): SeatProration {
  const evidence = input.evidence
  if (!evidence) return unavailable("no_membership_evidence")
  if (evidence.status === "unavailable") return unavailable(evidence.code)

  const startMicros = parseMicros(input.periodStart)
  const endMicros = parseMicros(input.periodEnd)
  const asOfMicros = parseMicros(input.asOf)
  if (startMicros === null || endMicros === null || asOfMicros === null || endMicros <= startMicros) {
    return unavailable("invalid_period")
  }
  const dayMicros = BigInt(DAY_MS) * BigInt(1000)
  if (startMicros % dayMicros !== BigInt(0) || endMicros % dayMicros !== BigInt(0)) {
    return unavailable("period_not_utc_day_aligned")
  }
  const daysInPeriod = Number((endMicros - startMicros) / dayMicros)
  if (daysInPeriod > MAX_PERIOD_DAYS) return unavailable("invalid_period")
  if (
    !Number.isInteger(input.includedSeats) ||
    input.includedSeats < 0 ||
    !Number.isInteger(input.extraSeatCents) ||
    input.extraSeatCents < 0
  ) {
    return unavailable("invalid_period")
  }

  // --- coverage: never claim time that was not recorded ---------------------
  const coverage = evidence.coverage
  if (!coverage) return unavailable("no_coverage", { start: isoOf(startMicros), end: isoOf(endMicros) })
  const coveredFrom = parseMicros(coverage.coveredFrom)
  const coverageRecorded = parseMicros(coverage.recordedAt)
  if (coveredFrom === null || coverageRecorded === null) return unavailable("malformed_membership_evidence")
  if (coverageRecorded > asOfMicros) {
    return unavailable("no_coverage", { start: isoOf(startMicros), end: isoOf(endMicros) })
  }
  if (coveredFrom > startMicros) {
    const gapEnd = coveredFrom < endMicros ? coveredFrom : endMicros
    return unavailable("coverage_gap", { start: isoOf(startMicros), end: isoOf(gapEnd) })
  }
  if (asOfMicros < endMicros) {
    const gapStart = asOfMicros > startMicros ? asOfMicros : startMicros
    return unavailable("period_not_closed", { start: isoOf(gapStart), end: isoOf(endMicros) })
  }

  // --- per-user billing timelines -------------------------------------------
  type Parsed = { id: string; seq: number; at: bigint; billable: boolean; user: string }
  const byUser = new Map<string, Parsed[]>()
  const used: Parsed[] = []
  for (const event of evidence.events) {
    const at = parseMicros(event.effectiveAt)
    const recorded = parseMicros(event.recordedAt)
    if (
      at === null ||
      recorded === null ||
      !Number.isInteger(event.shopSeq) ||
      typeof event.newBillable !== "boolean" ||
      !event.userId ||
      !event.id
    ) {
      return unavailable("malformed_membership_evidence")
    }
    if (recorded > asOfMicros || at >= endMicros) continue // not yet known, or after the period
    const parsed = { id: event.id, seq: event.shopSeq, at, billable: event.newBillable, user: event.userId }
    used.push(parsed)
    const list = byUser.get(event.userId) ?? []
    list.push(parsed)
    byUser.set(event.userId, list)
  }
  const order = (a: Parsed, b: Parsed) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.seq - b.seq)
  for (const list of byUser.values()) list.sort(order)

  // --- one seat-day per distinct user active at any instant of the day -------
  const days: { date: string; billableUsers: number; extraSeats: number }[] = []
  let extraSeatDays = 0
  for (let index = 0; index < daysInPeriod; index += 1) {
    const dayStart = startMicros + BigInt(index) * dayMicros
    const dayEnd = dayStart + dayMicros
    let billableUsers = 0
    for (const list of byUser.values()) {
      let state = false // no recorded event yet means not a member
      let active = false
      for (let cursor = 0; cursor < list.length; cursor += 1) {
        const event = list[cursor]
        if (event.at <= dayStart) {
          state = event.billable
          continue
        }
        if (event.at >= dayEnd) break
        // An instant inside the day: the state in force from there is the LAST event at
        // that same instant (a later-recorded event at the same instant wins).
        const next = list[cursor + 1]
        if (next && next.at === event.at) continue
        if (event.billable) active = true
      }
      if (state || active) billableUsers += 1
    }
    const extraSeats = Math.max(billableUsers - input.includedSeats, 0)
    extraSeatDays += extraSeats
    days.push({ date: isoOf(dayStart).slice(0, 10), billableUsers, extraSeats })
  }

  const numerator = extraSeatDays * input.extraSeatCents
  const denominator = daysInPeriod
  // Half-up, once, over the whole period: floor((2n + d) / 2d) for non-negative n.
  const roundedCents = Math.floor((2 * numerator + denominator) / (2 * denominator))
  return {
    state: "computed",
    periodStart: isoOf(startMicros),
    periodEnd: isoOf(endMicros),
    daysInPeriod,
    includedSeats: input.includedSeats,
    extraSeatCents: input.extraSeatCents,
    extraSeatDays,
    numerator,
    denominator,
    roundedCents,
    coveredFrom: isoOf(coveredFrom),
    days,
    evidenceEventIds: used.sort(order).map((event) => event.id),
  }
}

import { createHash } from "node:crypto"

import { APPROVED_COMMERCIAL_CATALOG_VERSION, FOUNDER_PILOT_POLICY } from "@/lib/approved-commercial-catalog"
import type { CommercialPeriodPreview } from "@/lib/commercial-usage-preview"
import { COMMERCIAL_METRICS, type CommercialMetric } from "@/lib/commercial-usage"

/**
 * Commercial settlement contract (Commercial Billing PR D). Pure: no clock, no
 * network, no Stripe, no database.
 *
 * Settlement does not price anything. It freezes the result of the one reviewed
 * deterministic preview (PR A usage + PR B seats) for ONE closed window into an
 * immutable document, and plans which finite, reviewed provider events carry that
 * result. Every number in a delivery is derived from the document; nothing
 * (metric, quantity, price, customer, period, tenant) is accepted from a model or
 * a caller.
 */

export const SETTLEMENT_DOCUMENT_VERSION = "settlement.v1"
export const SEAT_COMPONENT = "extra_operator_seat_proration" as const

/** Exactly the five approved usage metrics plus the daily extra-seat proration. */
export const SETTLEMENT_COMPONENTS = [...COMMERCIAL_METRICS, SEAT_COMPONENT] as const
export type SettlementComponent = (typeof SETTLEMENT_COMPONENTS)[number]

export function isSettlementComponent(value: unknown): value is SettlementComponent {
  return typeof value === "string" && (SETTLEMENT_COMPONENTS as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// Reviewed provider event mapping
// ---------------------------------------------------------------------------

export type MeterValueBasis = "billed_quantity" | "charge_cents"

/**
 * What number each component's provider event carries. REVIEWED here, not
 * configurable: fixed-rate outcome metrics carry the exact billed quantity (the
 * provider price would be the approved $1 / $5 / $10), while voice minutes, SMS
 * segments and seat proration carry the settled charge in cents, because their
 * price varies per fact (markup floors) or per day and a single provider unit
 * price cannot reproduce it. See COMMERCIAL_SETTLEMENT.md: this basis is PROPOSED
 * and must be confirmed at provisioning time; until then nothing is sent.
 */
export const REVIEWED_VALUE_BASIS: Readonly<Record<SettlementComponent, MeterValueBasis>> = {
  standard_digital_outcome: "billed_quantity",
  qualified_lead: "billed_quantity",
  confirmed_appointment: "billed_quantity",
  inbound_voice_agent_minute: "charge_cents",
  sms_segment: "charge_cents",
  extra_operator_seat_proration: "charge_cents",
}

export type MeterMapping = {
  /** Version recorded immutably on every settlement. */
  version: string
  /** `provisioned` only when the entries below equal the reviewed sandbox contract exactly. */
  status: "unprovisioned" | "provisioned"
  entries: readonly { component: SettlementComponent; valueBasis: MeterValueBasis; eventName: string | null }[]
}

/**
 * The reviewed TEST-mode meter event names, one per settlement component (Commercial Billing PR F2).
 * Single source of truth: the sandbox contract (`stripe-sandbox-contract.ts`) derives its meters from
 * this record, and a unit test pins the committed mapping to it. Founder direction 2026-11-18: the F1
 * recommended contract is the TEST-mode implementation contract. Production promotion still needs a
 * final reviewed release decision; nothing here is a live-mode name or an environment value.
 */
export const SETTLEMENT_METER_EVENT_NAMES: Readonly<Record<SettlementComponent, string>> = {
  standard_digital_outcome: "gradia_fp_2026_11_standard_digital_outcome",
  qualified_lead: "gradia_fp_2026_11_qualified_lead",
  confirmed_appointment: "gradia_fp_2026_11_confirmed_appointment",
  inbound_voice_agent_minute: "gradia_fp_2026_11_inbound_voice_agent_minute",
  sms_segment: "gradia_fp_2026_11_sms_segment",
  extra_operator_seat_proration: "gradia_fp_2026_11_extra_operator_seat_proration",
}

/**
 * The reviewed mapping as committed. Promoted from all-null to the reviewed contract names in PR F2
 * (TEST mode). The value basis is fixed by `REVIEWED_VALUE_BASIS` and cannot be supplied by a mapping.
 * Names are never taken from the environment, a request or a model. `validateMeterMapping` still checks
 * format, uniqueness and completeness at runtime, so a malformed edit fails closed.
 */
export const REVIEWED_SETTLEMENT_METER_MAPPING: MeterMapping = {
  version: "settlement-mapping.v2-sandbox-contract",
  status: "provisioned",
  entries: SETTLEMENT_COMPONENTS.map((component) => ({
    component,
    valueBasis: REVIEWED_VALUE_BASIS[component],
    eventName: SETTLEMENT_METER_EVENT_NAMES[component],
  })),
}

const EVENT_NAME = /^[a-z][a-z0-9_]{2,99}$/

export type MappingValidation =
  | { ok: true; mapping: MeterMapping }
  | { ok: false; reason: "settlement_mapping_unprovisioned" | "settlement_mapping_invalid" }

export function validateMeterMapping(mapping: MeterMapping): MappingValidation {
  if (mapping.status !== "provisioned") return { ok: false, reason: "settlement_mapping_unprovisioned" }
  if (!/^[A-Za-z0-9_.:-]{3,80}$/.test(mapping.version) || /unprovisioned/.test(mapping.version)) {
    return { ok: false, reason: "settlement_mapping_invalid" }
  }
  if (mapping.entries.length !== SETTLEMENT_COMPONENTS.length) return { ok: false, reason: "settlement_mapping_invalid" }
  const names = new Set<string>()
  for (const component of SETTLEMENT_COMPONENTS) {
    const entries = mapping.entries.filter((entry) => entry.component === component)
    if (entries.length !== 1) return { ok: false, reason: "settlement_mapping_invalid" }
    const [entry] = entries
    // The basis is fixed by review; a mapping can only supply names.
    if (entry.valueBasis !== REVIEWED_VALUE_BASIS[component]) return { ok: false, reason: "settlement_mapping_invalid" }
    if (typeof entry.eventName !== "string" || !EVENT_NAME.test(entry.eventName) || names.has(entry.eventName)) {
      return { ok: false, reason: "settlement_mapping_invalid" }
    }
    names.add(entry.eventName)
  }
  return { ok: true, mapping }
}

// ---------------------------------------------------------------------------
// Window and eligibility
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]00:?00)$/

export type WindowIssue =
  | "window_not_utc_instant"
  | "window_not_subscription_period"
  | "window_not_closed"

/**
 * The structural shape of a settlement window: a half-open UTC interval [start, end) of
 * at most 40 days that is already closed at `nowMs`. This does NOT authorize anything:
 * since PR E1 (founder decision 2026-11-16) the window must also EXACTLY equal a verified
 * Stripe subscription period, which only the database can attest (`subscription_period`
 * in the eligibility facts). The old UTC-midnight / 28–31-day rule was a placeholder and
 * is gone. The database re-checks all of this; this is the pure mirror used before any
 * read or write.
 */
export function validateSettlementWindow(start: string, end: string, nowMs: number): WindowIssue[] {
  if (!UTC_INSTANT.test(start) || !UTC_INSTANT.test(end)) return ["window_not_utc_instant"]
  const startMs = Date.parse(start)
  const endMs = Date.parse(end)
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return ["window_not_utc_instant"]
  const issues: WindowIssue[] = []
  if (endMs <= startMs || endMs - startMs > 40 * DAY_MS) issues.push("window_not_subscription_period")
  if (endMs > nowMs) issues.push("window_not_closed")
  return issues
}

/** Canonical ISO form of a validated window instant (also used in every identity). */
export function canonicalInstant(value: string): string {
  return new Date(Date.parse(value)).toISOString()
}

export type SettlementBlock =
  | WindowIssue
  | "no_billing_account"
  | "catalog_mismatch"
  | "no_platform_customer"
  | "account_requires_reconciliation"
  | "subscription_period_not_verified"
  | "subscription_period_history_incomplete"
  | "overlapping_settlement"
  | "preview_unavailable"
  | "preview_conflict"
  | "preview_invalid"
  | "usage_cap_exceeded"
  | "seat_proration_unavailable"
  | "fractional_quantity_unsupported"

export type SettlementEligibilityFacts = {
  window_closed: boolean
  /** The database's verdict on the exact verified Stripe subscription period (PR E1). */
  subscription_period: { verified: boolean; chain_complete: boolean }
  account_state?: string | null
  account_present: boolean
  catalog_version: string | null
  plan_key: string | null
  has_platform_customer: boolean
  overlapping_settlement_id: string | null
}

export function evaluateEligibility(facts: SettlementEligibilityFacts): SettlementBlock[] {
  const blocks: SettlementBlock[] = []
  if (!facts.window_closed) blocks.push("window_not_closed")
  if (!facts.subscription_period.verified) blocks.push("subscription_period_not_verified")
  else if (!facts.subscription_period.chain_complete) blocks.push("subscription_period_history_incomplete")
  if (facts.account_state === "reconciliation_required") blocks.push("account_requires_reconciliation")
  if (!facts.account_present) {
    blocks.push("no_billing_account")
  } else {
    if (facts.catalog_version !== APPROVED_COMMERCIAL_CATALOG_VERSION || facts.plan_key !== FOUNDER_PILOT_POLICY.planKey) {
      blocks.push("catalog_mismatch")
    }
    if (!facts.has_platform_customer) blocks.push("no_platform_customer")
  }
  if (facts.overlapping_settlement_id) blocks.push("overlapping_settlement")
  return blocks
}

// ---------------------------------------------------------------------------
// The settlement document
// ---------------------------------------------------------------------------

export type SettlementComponentLine = {
  component: SettlementComponent
  included_quantity: string | null
  recognized_quantity: string | null
  billed_quantity: string
  charge_cents: number
}

export type SettlementDocument = {
  document_version: typeof SETTLEMENT_DOCUMENT_VERSION
  state: "ok"
  catalog_version: string
  plan_key: string
  currency: "usd"
  window_start: string
  window_end: string
  base_cents: number
  seat_cents: number
  usage_cents: number
  usage_cap_cents: number
  total_cents: number
  /** Always exactly six, sorted by component name. */
  components: SettlementComponentLine[]
}

export type DocumentResult =
  | { ok: true; document: SettlementDocument; digest: string }
  | { ok: false; block: SettlementBlock; detail?: string }

/** Stable JSON: object keys sorted, arrays in order. Same value → same text. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`
}

export const sha256Hex = (text: string) => createHash("sha256").update(text).digest("hex")

/**
 * Freezes an `ok` preview with an available invoice total. Anything else —
 * unavailable, conflict, invalid, cap exceeded, missing seat evidence — is refused
 * with the exact block; there is no partial settlement and no zero fallback. The
 * document carries no `asOf`: the same evidence settles to the same document.
 */
export function buildSettlementDocument(preview: CommercialPeriodPreview): DocumentResult {
  switch (preview.state) {
    case "invalid":
      return { ok: false, block: "preview_invalid", detail: preview.issues[0] }
    case "unavailable":
      return { ok: false, block: "preview_unavailable", detail: preview.reasons[0]?.code }
    case "conflict":
      return { ok: false, block: "preview_conflict", detail: preview.conflicts[0]?.code }
    case "cap_exceeded":
      return { ok: false, block: "usage_cap_exceeded" }
    case "ok":
      break
  }
  const { subscription, usage } = preview
  if (subscription.seatProration.state !== "computed") {
    return { ok: false, block: "seat_proration_unavailable", detail: subscription.seatProration.code }
  }
  if (subscription.invoiceTotal.state !== "available") {
    return { ok: false, block: "preview_unavailable", detail: subscription.invoiceTotal.reason }
  }
  const total = subscription.invoiceTotal
  if (usage.lines.length !== COMMERCIAL_METRICS.length) {
    return { ok: false, block: "preview_invalid", detail: "usage_lines_incomplete" }
  }
  const byMetric = new Map<CommercialMetric, (typeof usage.lines)[number]>(usage.lines.map((line) => [line.metric, line]))
  const components: SettlementComponentLine[] = []
  for (const metric of COMMERCIAL_METRICS) {
    const line = byMetric.get(metric)
    if (!line) return { ok: false, block: "preview_invalid", detail: "usage_lines_incomplete" }
    components.push({
      component: metric,
      included_quantity: line.includedQuantity,
      recognized_quantity: line.recognizedQuantity,
      billed_quantity: line.billedQuantity,
      charge_cents: line.chargeCents,
    })
  }
  components.push({
    component: SEAT_COMPONENT,
    included_quantity: null,
    recognized_quantity: null,
    billed_quantity: String(subscription.seatProration.extraSeatDays),
    charge_cents: subscription.seatProration.roundedCents,
  })
  components.sort((a, b) => (a.component < b.component ? -1 : 1))
  const document: SettlementDocument = {
    document_version: SETTLEMENT_DOCUMENT_VERSION,
    state: "ok",
    catalog_version: preview.catalogVersion,
    plan_key: subscription.planKey,
    currency: "usd",
    window_start: preview.window.start,
    window_end: preview.window.end,
    base_cents: total.baseCents,
    seat_cents: total.seatCents,
    usage_cents: total.usageCents,
    usage_cap_cents: usage.capCents,
    total_cents: total.totalCents,
    components,
  }
  return { ok: true, document, digest: sha256Hex(canonicalJson(document)) }
}

// ---------------------------------------------------------------------------
// Delivery plan (the outbox identity of each provider event)
// ---------------------------------------------------------------------------

export type PlannedDelivery = {
  component: SettlementComponent
  value_basis: MeterValueBasis
  event_name: string
  /** Positive integer. */
  event_value: string
  provider_identifier: string
  /** ISO instant: the last second of the closed window. */
  event_timestamp: string
}

export type DeliveryPlanResult =
  | { ok: true; deliveries: PlannedDelivery[] }
  | { ok: false; block: "fractional_quantity_unsupported"; component: SettlementComponent }

/** Stable, local provider identity of one line: the same line always has the same identifier. */
export function providerIdentifier(shopId: string, windowStart: string, windowEnd: string, component: SettlementComponent): string {
  const digest = sha256Hex([shopId, APPROVED_COMMERCIAL_CATALOG_VERSION, canonicalInstant(windowStart), canonicalInstant(windowEnd), component].join("␟"))
  return `gradia-cb-settle-${digest.slice(0, 40)}`
}

export function buildDeliveryPlan(args: {
  shopId: string
  document: SettlementDocument
  mapping: MeterMapping
}): DeliveryPlanResult {
  const timestamp = new Date(Date.parse(args.document.window_end) - 1000).toISOString()
  const deliveries: PlannedDelivery[] = []
  for (const line of args.document.components) {
    const entry = args.mapping.entries.find((candidate) => candidate.component === line.component)
    if (!entry || entry.eventName === null) continue
    let value: string
    if (entry.valueBasis === "charge_cents") {
      value = String(line.charge_cents)
    } else {
      // The provider takes whole units. A fraction is refused, never rounded.
      if (!/^[0-9]+(?:\.0+)?$/.test(line.billed_quantity)) {
        return { ok: false, block: "fractional_quantity_unsupported", component: line.component }
      }
      value = line.billed_quantity.replace(/\.0+$/, "")
    }
    if (!/^[1-9][0-9]{0,17}$/.test(value)) continue // zero settles to nothing; nothing is delivered
    deliveries.push({
      component: line.component,
      value_basis: entry.valueBasis,
      event_name: entry.eventName,
      event_value: value,
      provider_identifier: providerIdentifier(args.shopId, args.document.window_start, args.document.window_end, line.component),
      event_timestamp: timestamp,
    })
  }
  return { ok: true, deliveries }
}

/** Stable identity of one settlement request: one settlement per exact window. */
export function settlementIdempotencyKey(shopId: string, windowStart: string, windowEnd: string): string {
  return `cset.v1.${sha256Hex([shopId, APPROVED_COMMERCIAL_CATALOG_VERSION, canonicalInstant(windowStart), canonicalInstant(windowEnd)].join("␟"))}`
}

// ---------------------------------------------------------------------------
// Delivery status
// ---------------------------------------------------------------------------

export type LineDeliveryStatus = "not_required" | "pending" | "in_flight" | "delivered" | "rejected" | "unknown"

/**
 * Derived, never stored. `provider_accepted` means ONLY that the provider
 * acknowledged the events: it is not an invoice, not a payment and not a
 * subscription state.
 */
export type SettlementDeliveryState =
  | "no_delivery_required"
  | "pending"
  | "in_flight"
  | "provider_accepted"
  | "reconciliation_required"

export function deriveDeliveryState(statuses: readonly LineDeliveryStatus[]): SettlementDeliveryState {
  if (statuses.some((status) => status === "unknown" || status === "rejected")) return "reconciliation_required"
  const required = statuses.filter((status) => status !== "not_required")
  if (required.length === 0) return "no_delivery_required"
  if (required.every((status) => status === "delivered")) return "provider_accepted"
  if (required.some((status) => status === "in_flight")) return "in_flight"
  return "pending"
}

// ---------------------------------------------------------------------------
// Provider acknowledgement verification
// ---------------------------------------------------------------------------

export type MeterEventExpectation = {
  eventName: string
  customerId: string
  value: string
  identifier: string
}

export type MeterAckCheck =
  | { ok: true }
  | { ok: false; code: "live_object_refused" | "response_mismatch" | "unreadable_response" }

/** A provider acknowledgement is accepted only when it matches the exact event we sent. */
export function verifyMeterAck(ack: unknown, expected: MeterEventExpectation): MeterAckCheck {
  if (!ack || typeof ack !== "object") return { ok: false, code: "unreadable_response" }
  const a = ack as Record<string, unknown>
  const payload = a.payload && typeof a.payload === "object" ? (a.payload as Record<string, unknown>) : null
  if (a.object !== "billing.meter_event" || typeof a.livemode !== "boolean" || !payload) {
    return { ok: false, code: "unreadable_response" }
  }
  if (a.livemode !== false) return { ok: false, code: "live_object_refused" }
  if (
    a.identifier !== expected.identifier ||
    a.event_name !== expected.eventName ||
    payload.stripe_customer_id !== expected.customerId ||
    String(payload.value) !== expected.value
  ) {
    return { ok: false, code: "response_mismatch" }
  }
  return { ok: true }
}

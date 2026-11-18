import { z } from "zod"

import {
  APPROVED_COMMERCIAL_CATALOG_VERSION,
  FOUNDER_APPROVED_COMMERCIAL_CATALOG,
  FOUNDER_PILOT_POLICY,
} from "@/lib/approved-commercial-catalog"
import { FOUNDER_PILOT_PRICE } from "@/lib/commercial-billing"
import {
  REVIEWED_VALUE_BASIS,
  SETTLEMENT_COMPONENTS,
  SETTLEMENT_METER_EVENT_NAMES,
  validateMeterMapping,
  type MeterMapping,
  type SettlementComponent,
  type SettlementDocument,
} from "@/lib/commercial-settlement"
import { STRIPE_COMMERCIAL_PROVISIONING_MANIFEST } from "@/lib/stripe-commercial-manifest"

/**
 * The Stripe SANDBOX contract for the Founder Pilot (Commercial Billing PR F).
 *
 * Pure: no clock, no network, no secrets, no Stripe object IDs. It states exactly what the
 * sandbox must contain for settlement to reach an invoice, and judges a read-only snapshot
 * of the sandbox against it. It provisions nothing: the founder (Dashboard) or a later
 * reviewed command creates the objects; this only REFUSES a sandbox that does not match.
 *
 * STATUS (PR F2): the meter event names, metered-price lookup keys and the meter API version are the
 * founder-directed TEST-mode implementation contract (2026-11-18). The base Product/Price come from the
 * already-approved catalog and manifest. `REVIEWED_SETTLEMENT_METER_MAPPING` carries the same event
 * names (single source: `SETTLEMENT_METER_EVENT_NAMES`). Promotion to production still requires a
 * final reviewed release decision (`SANDBOX_PRODUCTION_PROMOTION`).
 */

export const SANDBOX_CONTRACT_VERSION = "sandbox-contract.v2"
/** Founder-directed (2026-11-18) TEST-mode implementation contract. Not a production approval. */
export const SANDBOX_CONTRACT_STATUS = "founder_directed_test_mode_contract" as const
/** Production/live activation is NOT part of this contract; it needs a final reviewed release decision. */
export const SANDBOX_PRODUCTION_PROMOTION = "requires_final_reviewed_release_decision" as const

/**
 * One reviewed API version for the meter objects and meter events (the adapter's older pin,
 * 2024-06-20, predates Billing Meters). Verification sends it and refuses a provider that
 * does not echo it. Meter event sends use the same constant, so what is verified is what is used.
 */
export const COMMERCIAL_METER_API_VERSION = "2024-09-30.acacia"

export const SANDBOX_PRODUCT = {
  name: STRIPE_COMMERCIAL_PROVISIONING_MANIFEST.product.name,
  metadata: STRIPE_COMMERCIAL_PROVISIONING_MANIFEST.product.metadata,
} as const

export const SANDBOX_BASE_PRICE = {
  lookupKey: FOUNDER_PILOT_PRICE.lookupKey,
  unitAmountCents: FOUNDER_PILOT_PRICE.unitAmountCents,
  currency: FOUNDER_PILOT_PRICE.currency,
  interval: FOUNDER_PILOT_PRICE.interval,
} as const

const founderPilot = FOUNDER_APPROVED_COMMERCIAL_CATALOG.plans.find((plan) => plan.key === FOUNDER_PILOT_POLICY.planKey)
if (!founderPilot) throw new Error("Founder Pilot plan is missing")

/** Unit amount (cents) a metered Price charges per meter-event unit. Outcomes: the approved retail rate. Cents-valued meters: 1. */
function meteredUnitCents(component: SettlementComponent): number {
  if (REVIEWED_VALUE_BASIS[component] === "charge_cents") return 1
  const rate = founderPilot!.payg.rates.find((candidate) => candidate.metric === component)
  if (!rate || rate.pricing.kind !== "fixed") throw new Error(`No fixed retail rate for ${component}`)
  return rate.pricing.retailUnitCents
}

export type SandboxMeterSpec = {
  component: SettlementComponent
  /** The value the meter event carries (see REVIEWED_VALUE_BASIS). */
  valueBasis: (typeof REVIEWED_VALUE_BASIS)[SettlementComponent]
  eventName: string
  displayName: string
  aggregation: "sum"
  customerMappingKey: "stripe_customer_id"
  valueKey: "value"
  meteredPriceLookupKey: string
  meteredUnitAmountCents: number
}

export const SANDBOX_METERS: readonly SandboxMeterSpec[] = SETTLEMENT_COMPONENTS.map((component) => ({
  component,
  valueBasis: REVIEWED_VALUE_BASIS[component],
  eventName: SETTLEMENT_METER_EVENT_NAMES[component],
  displayName: `Gradia Founder Pilot ${component.replace(/_/g, " ")}`,
  aggregation: "sum" as const,
  customerMappingKey: "stripe_customer_id" as const,
  valueKey: "value" as const,
  meteredPriceLookupKey: `gradia_fp_2026_11_${component}_metered`,
  meteredUnitAmountCents: meteredUnitCents(component),
}))

/**
 * True only when a settlement mapping is provisioned, valid, and EXACTLY the sandbox contract: the same six
 * components, the same event names, the same value basis, nothing extra. The mapping is promoted from null names only
 * on this condition (PR F2); the readiness report and the worker re-check it at run time.
 */
export function mappingMatchesSandboxContract(mapping: MeterMapping): boolean {
  if (!validateMeterMapping(mapping).ok) return false
  if (mapping.entries.length !== SANDBOX_METERS.length) return false
  return SANDBOX_METERS.every((meter) => {
    const entry = mapping.entries.find((candidate) => candidate.component === meter.component)
    return entry !== undefined && entry.eventName === meter.eventName && entry.valueBasis === meter.valueBasis
  })
}

export const SANDBOX_REQUIRED_PRICE_LOOKUP_KEYS = [
  SANDBOX_BASE_PRICE.lookupKey,
  ...SANDBOX_METERS.map((meter) => meter.meteredPriceLookupKey),
] as const

// ---------------------------------------------------------------------------
// Findings (finite, secret-free)
// ---------------------------------------------------------------------------

export type SandboxFindingCode =
  | "api_version_not_echoed"
  | "api_version_mismatch"
  | "product_missing"
  | "product_duplicate"
  | "product_live"
  | "product_inactive"
  | "product_name_mismatch"
  | "product_metadata_mismatch"
  | "price_missing"
  | "price_duplicate"
  | "price_unreadable"
  | "price_live"
  | "price_inactive"
  | "price_lookup_mismatch"
  | "price_currency_mismatch"
  | "price_amount_mismatch"
  | "price_interval_mismatch"
  | "price_scheme_mismatch"
  | "price_usage_type_mismatch"
  | "price_product_mismatch"
  | "price_meter_mismatch"
  | "meters_list_incomplete"
  | "meters_unreadable"
  | "meter_missing"
  | "meter_inactive"
  | "meter_duplicate"
  | "meter_live"
  | "meter_aggregation_mismatch"
  | "meter_customer_mapping_mismatch"
  | "meter_value_key_mismatch"
  | "meter_time_window_mismatch"

export type SandboxFinding = { code: SandboxFindingCode; subject: string }

// ---------------------------------------------------------------------------
// Snapshot of the sandbox (what the read-only client collects)
// ---------------------------------------------------------------------------

export type SandboxSnapshot = {
  /** The `Stripe-Version` header the provider echoed for the verification requests (null: absent). */
  echoedApiVersion: string | null
  /** Every Price returned per lookup key, with its Product expanded. Raw provider objects. */
  pricesByLookupKey: Record<string, unknown[] | null>
  /** Every meter the provider listed, or null if the list could not be read. */
  meters: unknown[] | null
  /** False if the meter list was cut off (`has_more`): ambiguity is refusal. */
  metersComplete: boolean
}

const productSchema = z.object({
  id: z.string(),
  object: z.literal("product"),
  active: z.boolean(),
  livemode: z.boolean(),
  name: z.string(),
  metadata: z.record(z.string(), z.string()).nullable().optional(),
})
const priceSchema = z.object({
  id: z.string(),
  object: z.literal("price"),
  active: z.boolean(),
  livemode: z.boolean(),
  currency: z.string(),
  lookup_key: z.string().nullable(),
  type: z.string(),
  billing_scheme: z.string(),
  unit_amount: z.number().int().nullable(),
  product: z.union([z.string(), productSchema]),
  recurring: z
    .object({
      interval: z.string(),
      interval_count: z.number().int(),
      usage_type: z.string(),
      meter: z.string().nullable().optional(),
    })
    .nullable(),
})
const meterSchema = z.object({
  id: z.string(),
  object: z.literal("billing.meter"),
  livemode: z.boolean(),
  status: z.string(),
  event_name: z.string(),
  default_aggregation: z.object({ formula: z.string() }),
  customer_mapping: z.object({ type: z.string(), event_payload_key: z.string() }),
  value_settings: z.object({ event_payload_key: z.string() }),
  event_time_window: z.string().nullable(),
})

export type SandboxReadiness = {
  ready: boolean
  findings: SandboxFinding[]
  /** Verified provider-side meter ids by component, only for meters that passed every check. */
  verifiedMeterIds: Partial<Record<SettlementComponent, string>>
  /**
   * Provider Price ids of the exact Founder Pilot item set, ONLY when `ready` (every Price passed every check).
   * Resolved by lookup key at run time; never committed. Empty when not ready.
   */
  verifiedPrices: { base: string; metered: Partial<Record<SettlementComponent, string>> } | null
}

const add = (findings: SandboxFinding[], code: SandboxFindingCode, subject: string) => {
  if (!findings.some((f) => f.code === code && f.subject === subject)) findings.push({ code, subject })
}

/**
 * Judges a sandbox snapshot against the contract. Refuses (never repairs): absent, duplicate,
 * live, wrong currency, wrong amount, wrong interval, wrong aggregation, wrong API version.
 * The same snapshot always gives the same findings in the same order.
 */
export function evaluateSandboxReadiness(snapshot: SandboxSnapshot): SandboxReadiness {
  const findings: SandboxFinding[] = []

  if (snapshot.echoedApiVersion === null) add(findings, "api_version_not_echoed", "api_version")
  else if (snapshot.echoedApiVersion !== COMMERCIAL_METER_API_VERSION) add(findings, "api_version_mismatch", "api_version")

  // ---- meters (evaluated first: metered prices must point at the verified meter) ----
  const verifiedMeterIds: Partial<Record<SettlementComponent, string>> = {}
  if (snapshot.meters === null) {
    add(findings, "meters_unreadable", "meters")
  } else {
    if (!snapshot.metersComplete) add(findings, "meters_list_incomplete", "meters")
    const parsed = snapshot.meters.map((raw) => meterSchema.safeParse(raw))
    if (parsed.some((p) => !p.success)) add(findings, "meters_unreadable", "meters")
    const meters = parsed.flatMap((p) => (p.success ? [p.data] : []))
    for (const spec of SANDBOX_METERS) {
      const subject = spec.component
      const same = meters.filter((meter) => meter.event_name === spec.eventName)
      if (same.length === 0) {
        add(findings, "meter_missing", subject)
        continue
      }
      const active = same.filter((meter) => meter.status === "active")
      if (active.length === 0) {
        add(findings, "meter_inactive", subject)
        continue
      }
      if (active.length > 1) {
        add(findings, "meter_duplicate", subject)
        continue
      }
      const meter = active[0]
      let ok = true
      if (meter.livemode !== false) {
        add(findings, "meter_live", subject)
        ok = false
      }
      if (meter.default_aggregation.formula !== spec.aggregation) {
        add(findings, "meter_aggregation_mismatch", subject)
        ok = false
      }
      if (meter.customer_mapping.type !== "by_id" || meter.customer_mapping.event_payload_key !== spec.customerMappingKey) {
        add(findings, "meter_customer_mapping_mismatch", subject)
        ok = false
      }
      if (meter.value_settings.event_payload_key !== spec.valueKey) {
        add(findings, "meter_value_key_mismatch", subject)
        ok = false
      }
      if (meter.event_time_window !== null) {
        add(findings, "meter_time_window_mismatch", subject)
        ok = false
      }
      if (ok) verifiedMeterIds[spec.component] = meter.id
    }
  }

  // ---- Product + prices ----
  const productIds = new Set<string>()
  const priceIds: Record<string, string> = {}
  const checkPrice = (
    lookupKey: string,
    subject: string,
    expect: { unitAmountCents: number; usageType: "licensed" | "metered"; meterId?: string }
  ) => {
    const list = snapshot.pricesByLookupKey[lookupKey]
    if (list === null || list === undefined) return add(findings, "price_unreadable", subject)
    if (list.length === 0) return add(findings, "price_missing", subject)
    if (list.length > 1) return add(findings, "price_duplicate", subject)
    const parsed = priceSchema.safeParse(list[0])
    if (!parsed.success) return add(findings, "price_unreadable", subject)
    const price = parsed.data
    priceIds[subject] = price.id
    if (price.livemode !== false) add(findings, "price_live", subject)
    if (!price.active) add(findings, "price_inactive", subject)
    if (price.lookup_key !== lookupKey) add(findings, "price_lookup_mismatch", subject)
    if (price.currency !== SANDBOX_BASE_PRICE.currency) add(findings, "price_currency_mismatch", subject)
    if (price.type !== "recurring" || price.billing_scheme !== "per_unit" || price.unit_amount !== expect.unitAmountCents) {
      add(findings, price.billing_scheme !== "per_unit" || price.type !== "recurring" ? "price_scheme_mismatch" : "price_amount_mismatch", subject)
    }
    if (!price.recurring || price.recurring.interval !== SANDBOX_BASE_PRICE.interval || price.recurring.interval_count !== 1) {
      add(findings, "price_interval_mismatch", subject)
    } else if (price.recurring.usage_type !== expect.usageType) {
      add(findings, "price_usage_type_mismatch", subject)
    }
    if (expect.meterId !== undefined && price.recurring && price.recurring.meter !== expect.meterId) {
      add(findings, "price_meter_mismatch", subject)
    }
    if (typeof price.product === "string") add(findings, "product_missing", subject)
    else {
      productIds.add(price.product.id)
      const product = price.product
      if (product.livemode !== false) add(findings, "product_live", subject)
      if (!product.active) add(findings, "product_inactive", subject)
      if (product.name !== SANDBOX_PRODUCT.name) add(findings, "product_name_mismatch", subject)
      const md = product.metadata ?? {}
      if (md.catalog_version !== SANDBOX_PRODUCT.metadata.catalog_version || md.plan_key !== SANDBOX_PRODUCT.metadata.plan_key) {
        add(findings, "product_metadata_mismatch", subject)
      }
    }
  }

  checkPrice(SANDBOX_BASE_PRICE.lookupKey, "base_price", { unitAmountCents: SANDBOX_BASE_PRICE.unitAmountCents, usageType: "licensed" })
  for (const spec of SANDBOX_METERS) {
    checkPrice(spec.meteredPriceLookupKey, spec.component, {
      unitAmountCents: spec.meteredUnitAmountCents,
      usageType: "metered",
      // Only meaningful once the meter itself verified; an unverified meter already has a finding.
      meterId: verifiedMeterIds[spec.component],
    })
  }
  // One Product carries the base Price and every metered Price.
  if (productIds.size > 1) add(findings, "product_duplicate", "product")

  const order = (f: SandboxFinding) => `${f.code}\u0000${f.subject}`
  findings.sort((a, b) => (order(a) < order(b) ? -1 : 1))
  const ready = findings.length === 0
  const verifiedPrices = ready
    ? {
        base: priceIds.base_price,
        metered: Object.fromEntries(SANDBOX_METERS.map((m) => [m.component, priceIds[m.component]])) as Partial<Record<SettlementComponent, string>>,
      }
    : null
  return { ready, findings, verifiedMeterIds, verifiedPrices }
}

// ---------------------------------------------------------------------------
// Invoice reconstruction: what Stripe would charge for the settled lines
// ---------------------------------------------------------------------------

export type InvoiceReconstruction = {
  baseCents: number
  meteredCents: number
  totalCents: number
  /** The exact meter event value per component (the only usage Stripe is told). */
  eventValues: Partial<Record<SettlementComponent, string>>
}

/**
 * The Stripe invoice implied by the SETTLED document: the licensed base Price plus, per
 * component, the meter event value times the metered unit price. Events are derived from the
 * document alone (never from the UI or metadata). The document's own total must equal this;
 * any difference means the meter basis or a metered price is wrong, and nothing may be sent.
 */
export function reconstructInvoiceFromDocument(document: SettlementDocument): InvoiceReconstruction {
  let metered = 0
  const eventValues: Partial<Record<SettlementComponent, string>> = {}
  for (const spec of SANDBOX_METERS) {
    const line = document.components.find((candidate) => candidate.component === spec.component)
    if (!line) throw new Error(`Settlement document is missing ${spec.component}`)
    const value = spec.valueBasis === "charge_cents" ? String(line.charge_cents) : line.billed_quantity.replace(/\.0+$/, "")
    if (!/^[0-9]+$/.test(value)) throw new Error(`Fractional ${spec.component} quantity cannot be metered`)
    eventValues[spec.component] = value
    metered += Number(value) * spec.meteredUnitAmountCents
  }
  const baseCents = SANDBOX_BASE_PRICE.unitAmountCents
  return { baseCents, meteredCents: metered, totalCents: baseCents + metered, eventValues }
}

export type InvoiceAuthorization =
  | { ok: true }
  | { ok: false; code: "invoice_total_mismatch" | "usage_exceeds_cap" | "base_mismatch" }

/** The invoice Stripe would produce must equal the settled total and can never exceed base + seats + the cap. */
export function authorizeInvoiceReconstruction(document: SettlementDocument, rebuilt: InvoiceReconstruction): InvoiceAuthorization {
  if (rebuilt.baseCents !== document.base_cents) return { ok: false, code: "base_mismatch" }
  if (rebuilt.totalCents !== document.total_cents) return { ok: false, code: "invoice_total_mismatch" }
  if (document.usage_cents > document.usage_cap_cents) return { ok: false, code: "usage_exceeds_cap" }
  if (rebuilt.totalCents > document.base_cents + document.seat_cents + document.usage_cap_cents) {
    return { ok: false, code: "usage_exceeds_cap" }
  }
  return { ok: true }
}

/** Operator-facing: the manual Stripe Dashboard steps. Never performed by code; never claimed as done. */
export const SANDBOX_MANUAL_STEPS: readonly { id: string; text: string }[] = [
  { id: "dashboard_test_mode", text: "Work in the Stripe Dashboard TEST-mode sandbox only (never live mode)." },
  { id: "product", text: `Create the Product named "${SANDBOX_PRODUCT.name}" with metadata catalog_version=${APPROVED_COMMERCIAL_CATALOG_VERSION} and plan_key=${FOUNDER_PILOT_POLICY.planKey}.` },
  { id: "base_price", text: `Create the recurring monthly USD ${(SANDBOX_BASE_PRICE.unitAmountCents / 100).toFixed(2)} licensed Price with lookup key ${SANDBOX_BASE_PRICE.lookupKey}.` },
  { id: "meters", text: `Create ${SANDBOX_METERS.length} billing meters (sum aggregation, customer mapping by_id stripe_customer_id, value key "value", no event time window) with the event names printed by the verifier.` },
  { id: "metered_prices", text: "Create one metered monthly USD Price per meter on the same Product with the printed lookup key and unit amount (outcomes at the approved retail rate; voice, SMS and seat at 1 cent per cent-valued unit)." },
  { id: "webhook_endpoint", text: `Add a TEST-mode webhook endpoint for POST /api/stripe/commercial-webhook pinned to API version ${COMMERCIAL_METER_API_VERSION}; copy its signing secret into GRADIA_COMMERCIAL_STRIPE_WEBHOOK_SECRET locally only.` },
  { id: "portal_config", text: "Configure the test-mode Customer Portal (what a customer may cancel/change is a founder decision)." },
  { id: "mapping_commit", text: "When the only blocker left is settlement_mapping_unprovisioned and the founder has confirmed the contract, a REVIEWED commit replaces the null event names in REVIEWED_SETTLEMENT_METER_MAPPING and flips its status. No environment variable can do this." },
  { id: "attach_metered_items", text: "Attaching metered Prices to the subscription (and the webhook rule that accepts them) is PR F2 and a founder decision. Until then meter events cannot appear on a Stripe invoice." },
]

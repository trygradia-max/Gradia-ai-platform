import { createHmac, randomBytes, randomUUID } from "node:crypto"

import { buildFounderPilotLineItems, evaluateSubscriptionItems, FOUNDER_PILOT_ITEM_SET_DIGEST } from "@/lib/commercial-subscription-items"
import { COMMERCIAL_METER_API_VERSION, SANDBOX_CONTRACT_VERSION, SANDBOX_METERS, SANDBOX_BASE_PRICE, evaluateSandboxReadiness } from "@/lib/stripe-sandbox-contract"
import { parseVerifiedWebhook, verifyCommercialSignature } from "@/lib/commercial-webhook"
import { REVIEWED_SETTLEMENT_METER_MAPPING, verifyMeterAck, type SettlementComponent } from "@/lib/commercial-settlement"
import { createMeterEvidenceReader, createSettlementProvider } from "@/lib/commercial-settlement-provider"
import { StripeError, stripeCommercialRequest, type CommercialStripeTransportConfig } from "@/lib/stripe"
import { createPlatformStripeClient, resolveCommercialStripeConfig } from "@/lib/stripe-commercial"
import { collectSandboxSnapshot } from "@/lib/stripe-sandbox-snapshot"

/**
 * Real Stripe TEST-mode test-clock acceptance harness (Commercial Billing PR F2).
 *
 * EXPLICITLY OPT-IN. It mutates ONLY the configured Stripe TEST sandbox, only objects it creates itself, and it
 * is never part of `npm test`, `npm run test:int` or CI. Refusals (all before any request):
 *   - not opted in (env flag AND confirmation flag), or running under CI;
 *   - a live-shaped key, a mode that is not `test`, or an API base that is not the official host / loopback;
 * and during the run:
 *   - every request must match an allowlist of (method, path) for objects THIS run created (no other account,
 *     charge, refund, credit note, payout or customer can be addressed);
 *   - any response that says `livemode: true`, or carries a live-shaped id / key, aborts the run.
 * Output is finite: step ids, PASS / FAIL / NOT_RUN / OBSERVED / MANUAL, a finite code and integer cents or counts.
 * It never prints or stores a secret, a Stripe object id, a URL, a raw payload or a personal datum. The test clock
 * (and with it the customer and subscription) is always deleted in `finally`; if that fails the evidence says so and
 * the runbook gives the exact manual cleanup.
 *
 * What it proves vs. what it cannot (Stripe offers no API for either): see `HARNESS_LIMITATIONS`.
 */

export const TEST_CLOCK_EVIDENCE_VERSION = "test-clock-evidence.v1"
export const TEST_CLOCK_OPT_IN_ENV = "GRADIA_STRIPE_TEST_CLOCK_ACCEPTANCE"
export const TEST_CLOCK_CONFIRM_FLAG = "--i-understand-this-mutates-stripe-test"

export type StepStatus = "PASS" | "FAIL" | "NOT_RUN" | "OBSERVED" | "MANUAL"

export const AUTOMATED_STEPS = [
  "sandbox_contract",
  "clock_and_customer",
  "checkout_session_exact_items",
  "subscription_exact_items",
  "webhook_normalization_exact_items",
  "first_period",
  "meter_events_sent",
  "meter_usage_visible",
  "invoice_preview",
  "renewal_invoice_with_usage",
  "late_usage_after_finalization",
  "payment_failure_lapse",
  "recovery",
  "next_period",
  "cancellation",
] as const
export type AutomatedStep = (typeof AUTOMATED_STEPS)[number]

/** Steps Stripe's API cannot perform for us: a human does them and attests (never auto-passed). */
export const MANUAL_STEPS = ["hosted_checkout_completion", "stripe_delivered_webhook"] as const
export type ManualStep = (typeof MANUAL_STEPS)[number]

export const HARNESS_LIMITATIONS: readonly string[] = [
  "Hosted Checkout cannot be completed by API: the harness proves the Checkout Session via the real client (exact line items, retrieval verification) and creates the equivalent subscription by API. Completing a hosted Checkout in a browser is a MANUAL step.",
  "Stripe-delivered webhooks need a public endpoint: the harness normalizes REAL provider subscription objects through the production webhook rules inside a locally signed envelope. It does not prove Stripe's own delivery or signature. Confirming a Stripe-delivered, signed delivery to the commercial endpoint is a MANUAL step.",
  "Meter events cannot be deleted from a meter's history. They are attached to a test customer that is deleted with the test clock.",
  "The harness does not touch Supabase: settlement, delivery claims and the lapse gate are covered by the integration suites against a faithful local fake, not by this run.",
]

export type StepResult = { id: AutomatedStep | ManualStep; status: StepStatus; code: string | null; numbers?: Record<string, number> }

export type AcceptanceEvidence = {
  version: typeof TEST_CLOCK_EVIDENCE_VERSION
  mode: "test"
  contractVersion: string
  itemSetDigest: string
  meterApiVersion: string
  mappingVersion: string
  /** ISO timestamp of the run's end. */
  completedAt: string
  overall: "PASSED" | "FAILED" | "INCOMPLETE" | "REFUSED"
  steps: StepResult[]
  cleanup: "deleted" | "failed" | "not_needed"
  limitations: readonly string[]
}

export function currentContractFingerprint() {
  return {
    contractVersion: SANDBOX_CONTRACT_VERSION,
    itemSetDigest: FOUNDER_PILOT_ITEM_SET_DIGEST,
    meterApiVersion: COMMERCIAL_METER_API_VERSION,
    mappingVersion: REVIEWED_SETTLEMENT_METER_MAPPING.version,
  }
}

// ---------- guard ----------

export type GuardResult =
  | { ok: true; config: CommercialStripeTransportConfig }
  | { ok: false; code: "not_opted_in" | "not_confirmed" | "ci_refused" | "billing_unconfigured" | "billing_misconfigured" }

const TRUTHY_CI = (value: string | undefined) => value !== undefined && value !== "" && !/^(0|false|no)$/i.test(value)

/** Refuses before any request. Live-shaped keys, non-test mode and foreign API bases are `billing_misconfigured`. */
export function evaluateHarnessGuard(env: Record<string, string | undefined>, confirmed: boolean): GuardResult {
  if (env[TEST_CLOCK_OPT_IN_ENV]?.trim() !== "1") return { ok: false, code: "not_opted_in" }
  if (!confirmed) return { ok: false, code: "not_confirmed" }
  if (TRUTHY_CI(env.CI) || TRUTHY_CI(env.GITHUB_ACTIONS) || TRUTHY_CI(env.VERCEL) || TRUTHY_CI(env.BUILDKITE)) return { ok: false, code: "ci_refused" }
  const config = resolveCommercialStripeConfig(env)
  if (!config.ok) return { ok: false, code: config.reason }
  return { ok: true, config: config.config }
}

// ---------- fenced transport ----------

type Request = typeof stripeCommercialRequest

const ID = "[A-Za-z0-9_]{4,120}"
const ALLOWED: readonly { method: "GET" | "POST" | "DELETE"; path: RegExp; owned?: number }[] = [
  { method: "GET", path: /^\/prices$/ },
  { method: "GET", path: /^\/billing\/meters$/ },
  { method: "GET", path: new RegExp(`^/billing/meters/${ID}/event_summaries$`) },
  { method: "POST", path: /^\/billing\/meter_events$/ },
  { method: "POST", path: /^\/test_helpers\/test_clocks$/ },
  { method: "GET", path: new RegExp(`^/test_helpers/test_clocks/(${ID})$`), owned: 1 },
  { method: "POST", path: new RegExp(`^/test_helpers/test_clocks/(${ID})/advance$`), owned: 1 },
  { method: "DELETE", path: new RegExp(`^/test_helpers/test_clocks/(${ID})$`), owned: 1 },
  { method: "POST", path: /^\/customers$/ },
  { method: "POST", path: new RegExp(`^/customers/(${ID})$`), owned: 1 },
  { method: "POST", path: new RegExp(`^/payment_methods/(${ID})/attach$`) },
  { method: "POST", path: /^\/checkout\/sessions$/ },
  { method: "GET", path: new RegExp(`^/checkout/sessions/(${ID})$`), owned: 1 },
  { method: "POST", path: new RegExp(`^/checkout/sessions/(${ID})/expire$`), owned: 1 },
  { method: "POST", path: /^\/subscriptions$/ },
  { method: "GET", path: new RegExp(`^/subscriptions/(${ID})$`), owned: 1 },
  { method: "DELETE", path: new RegExp(`^/subscriptions/(${ID})$`), owned: 1 },
  { method: "GET", path: /^\/invoices\/create_preview$/ },
  { method: "GET", path: /^\/invoices$/ },
  { method: "POST", path: new RegExp(`^/invoices/(${ID})/pay$`), owned: 1 },
]

const LIVE_SHAPED = /"livemode"\s*:\s*true|(sk|rk|pk)_live_|(cs|bps|whsec)_live_|_live_[A-Za-z0-9]/

export class HarnessAbort extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

/**
 * The only transport the harness uses. Allowlist of (method, path); mutating requests may only address ids that THIS
 * run created; every response is scanned for live-mode markers. Throws HarnessAbort with a finite code.
 */
export function createFencedRequest(base: Request, owned: Set<string>): Request {
  return (async (config, input) => {
    const rule = ALLOWED.find((candidate) => candidate.method === input.method && candidate.path.test(input.path))
    if (!rule) throw new HarnessAbort("request_not_allowlisted")
    if (rule.owned !== undefined) {
      const id = rule.path.exec(input.path)?.[rule.owned]
      if (!id || !owned.has(id)) throw new HarnessAbort("object_not_created_by_this_run")
    }
    const response = await base(config, input)
    let text = ""
    try {
      text = JSON.stringify(response)
    } catch {
      throw new HarnessAbort("unreadable_response")
    }
    if (LIVE_SHAPED.test(text)) throw new HarnessAbort("live_object_refused")
    return response as never
  }) as Request
}

// ---------- the run ----------

export type HarnessDeps = {
  request?: Request
  sleep?: (ms: number) => Promise<void>
  /** Real wall-clock seconds (meter event timestamps are validated against it). */
  nowSeconds?: () => number
  /** Operator-facing progress lines (finite codes only). */
  log?: (line: string) => void
}

const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null)
const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null)
const idOf = (v: unknown): string | null => str(v) ?? str(record(v).id)

/** The usage the run reports: deterministic, tiny, and priced by the contract (quantities for outcomes, cents otherwise). */
export const ACCEPTANCE_USAGE: Readonly<Record<SettlementComponent, number>> = {
  standard_digital_outcome: 2,
  qualified_lead: 1,
  confirmed_appointment: 1,
  inbound_voice_agent_minute: 150,
  sms_segment: 40,
  extra_operator_seat_proration: 300,
}
export const ACCEPTANCE_METERED_CENTS = SANDBOX_METERS.reduce((sum, m) => sum + ACCEPTANCE_USAGE[m.component] * m.meteredUnitAmountCents, 0)
export const ACCEPTANCE_LATE_EVENT = { component: "qualified_lead" as const, value: 1 }

const safeCode = (error: unknown): string => {
  if (error instanceof HarnessAbort) return error.code
  if (error instanceof StripeError) {
    const code = error.code && /^[a-z0-9_]{1,50}$/.test(error.code) ? error.code : "unclassified"
    return `provider_${error.status}_${code}`.slice(0, 63)
  }
  return "unexpected_error"
}

class StopRun extends Error {}

export async function runTestClockAcceptance(
  env: Record<string, string | undefined>,
  confirmed: boolean,
  deps: HarnessDeps = {}
): Promise<AcceptanceEvidence> {
  const log = deps.log ?? (() => undefined)
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const nowSeconds = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000))
  const steps: StepResult[] = []
  const fingerprint = currentContractFingerprint()
  const finish = (overall: AcceptanceEvidence["overall"], cleanup: AcceptanceEvidence["cleanup"]): AcceptanceEvidence => ({
    version: TEST_CLOCK_EVIDENCE_VERSION,
    mode: "test",
    ...fingerprint,
    completedAt: new Date(nowSeconds() * 1000).toISOString(),
    overall,
    steps,
    cleanup,
    limitations: HARNESS_LIMITATIONS,
  })
  const markRemainingNotRun = (code = "earlier_step_failed") => {
    for (const id of AUTOMATED_STEPS) if (!steps.some((s) => s.id === id)) steps.push({ id, status: "NOT_RUN", code })
  }
  const withManual = () => {
    for (const id of MANUAL_STEPS) steps.push({ id, status: "MANUAL", code: "operator_attestation_required" })
  }

  const guard = evaluateHarnessGuard(env, confirmed)
  if (!guard.ok) {
    log(`REFUSED: ${guard.code}`)
    steps.push({ id: "sandbox_contract", status: "NOT_RUN", code: guard.code })
    markRemainingNotRun("refused_before_any_request")
    withManual()
    return finish("REFUSED", "not_needed")
  }
  const config = guard.config
  const owned = new Set<string>()
  const request = createFencedRequest(deps.request ?? stripeCommercialRequest, owned)
  const get = <T = unknown>(path: string, body?: Record<string, string | number | boolean>) =>
    request<T>(config, { method: "GET", path, body, apiVersion: COMMERCIAL_METER_API_VERSION })
  const post = <T = unknown>(path: string, body: Record<string, string | number | boolean | undefined>, key?: string) =>
    request<T>(config, { method: "POST", path, body, idempotencyKey: key, apiVersion: COMMERCIAL_METER_API_VERSION })
  const del = <T = unknown>(path: string) => request<T>(config, { method: "DELETE", path, apiVersion: COMMERCIAL_METER_API_VERSION })

  const runId = randomBytes(5).toString("hex")
  const label = `gradia-f2-acceptance-${runId}`
  let clockId: string | null = null
  let customerId: string | null = null
  let subId: string | null = null
  let sessionId: string | null = null
  let failed = false

  const record_ = (id: AutomatedStep, status: StepStatus, code: string | null = null, numbers?: Record<string, number | undefined>) => {
    const clean = numbers ? (Object.fromEntries(Object.entries(numbers).filter(([, v]) => typeof v === "number")) as Record<string, number>) : undefined
    steps.push({ id, status, code, ...(clean ? { numbers: clean } : {}) })
    log(`step ${id}: ${status}${code ? ` (${code})` : ""}`)
    if (status === "FAIL") failed = true
  }
  /** Runs one step; a throw is a FAIL with a finite code and stops the run (cleanup still happens). */
  type StepOut = { status?: StepStatus; code?: string | null; numbers?: Record<string, number | undefined> }
  const step = async (id: AutomatedStep, fn: () => Promise<StepOut | void>) => {
    if (failed) return
    try {
      const out = (await fn()) ?? {}
      record_(id, out.status ?? "PASS", out.code ?? null, out.numbers)
    } catch (error) {
      record_(id, "FAIL", safeCode(error))
    }
  }
  const mustPass = (condition: boolean, code: string) => {
    if (!condition) throw new HarnessAbort(code)
  }

  const waitClockReady = async () => {
    for (let i = 0; i < 60; i += 1) {
      const clock = record(await get(`/test_helpers/test_clocks/${clockId}`))
      if (clock.status === "ready") return
      mustPass(clock.status === "advancing", "clock_failed")
      await sleep(3_000)
    }
    throw new HarnessAbort("clock_advance_timeout")
  }
  const advanceTo = async (seconds: number) => {
    await post(`/test_helpers/test_clocks/${clockId}/advance`, { frozen_time: seconds })
    await sleep(1_000)
    await waitClockReady()
  }
  const readSub = async () => {
    const sub = record(await get(`/subscriptions/${subId}`))
    mustPass(sub.livemode === false, "live_object_refused")
    return sub
  }
  /** The production normalization of a REAL retrieved subscription, inside a locally signed envelope. */
  const normalize = (sub: Record<string, unknown>, type = "customer.subscription.updated") => {
    const secret = `whsec_${randomBytes(16).toString("hex")}`
    const body = JSON.stringify({ id: `evt_${randomBytes(8).toString("hex")}`, object: "event", type, created: nowSeconds(), livemode: false, data: { object: sub } })
    const t = nowSeconds()
    const header = `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`
    mustPass(verifyCommercialSignature({ rawBody: body, header, secret, nowMs: t * 1000 }).ok, "local_signature_failed")
    const parsed = parseVerifiedWebhook(body)
    mustPass(parsed.ok && parsed.kind === "handled", "normalization_refused")
    return parsed.ok && parsed.kind === "handled" ? parsed.event.facts : {}
  }

  const client = createPlatformStripeClient(config, request)
  let frozenTime = 0
  let periodEnd = 0
  let secondPeriodEnd = 0
  let visaPm: string | null = null
  const usageStart = nowSeconds()
  let expectedTotal = SANDBOX_BASE_PRICE.unitAmountCents + ACCEPTANCE_METERED_CENTS

  try {
    // 1. The sandbox must hold the exact contract (read-only).
    await step("sandbox_contract", async () => {
      const snapshot = await collectSandboxSnapshot(config, request)
      mustPass(!("failure" in snapshot), "sandbox_unreachable")
      const readiness = evaluateSandboxReadiness(snapshot as Exclude<typeof snapshot, { failure: string }>)
      if (!readiness.ready) return { status: "FAIL", code: `sandbox_${readiness.findings[0]?.code ?? "not_ready"}`.slice(0, 63) }
    })

    // 2. A test clock starting ~25 days ago (so period 1 spans real "now": meter event timestamps are validated
    //    against the real clock) and a customer on it with a test card that succeeds.
    await step("clock_and_customer", async () => {
      const frozen = usageStart - 25 * 86_400
      frozenTime = frozen
      const clock = record(await post("/test_helpers/test_clocks", { frozen_time: frozen, name: label }))
      clockId = str(clock.id)
      mustPass(clockId !== null && clock.livemode === false, "clock_not_created")
      owned.add(clockId as string)
      const customer = record(
        await post("/customers", {
          test_clock: clockId as string,
          "metadata[gradia_acceptance]": label,
          payment_method: "pm_card_visa",
          "invoice_settings[default_payment_method]": "pm_card_visa",
        })
      )
      customerId = str(customer.id)
      mustPass(customerId !== null && customer.livemode === false, "customer_not_created")
      owned.add(customerId as string)
      visaPm = idOf(record(customer.invoice_settings).default_payment_method)
      mustPass(visaPm !== null, "payment_method_not_attached")
      owned.add(visaPm as string)
    })

    // 3. The REAL Checkout client (over the fenced transport): exact line items out, exact line items verified back.
    await step("checkout_session_exact_items", async () => {
      const resolved = await client.resolveFounderPilotItemSet()
      if (!resolved.ok) return { status: "FAIL", code: resolved.code }
      const shopId = randomUUID()
      const attemptId = randomUUID()
      const session = await client.createCheckoutSession({
        lineItems: resolved.lineItems,
        customerId: customerId as string,
        shopId,
        attemptId,
        successUrl: "https://example.com/gradia-acceptance/success",
        cancelUrl: "https://example.com/gradia-acceptance/cancel",
        idempotencyKey: `gradia-acc-${runId}-session`,
      })
      mustPass(session.status === "open", "session_not_open")
      sessionId = session.id
      owned.add(session.id)
      const retrieved = await client.retrieveCheckoutSession({ sessionId: session.id, binding: { shopId, attemptId, customerId: customerId as string } })
      mustPass(retrieved.ok, "session_binding_or_items_not_exact")
    })

    // 4. The equivalent subscription by API (hosted Checkout cannot be completed by API): exact items, any order.
    await step("subscription_exact_items", async () => {
      const resolved = await client.resolveFounderPilotItemSet()
      mustPass(resolved.ok, "item_set_not_ready")
      if (!resolved.ok) return
      // Reverse the order on purpose: the rule is order-independent.
      const ordered = [...resolved.lineItems].reverse()
      const created = record(
        await post(
          "/subscriptions",
          {
            customer: customerId as string,
            ...Object.fromEntries(ordered.flatMap((item, i) => [[`items[${i}][price]`, item.priceId], ...(item.quantity !== undefined ? [[`items[${i}][quantity]`, item.quantity]] : [])])),
            "metadata[gradia_acceptance]": label,
            "metadata[catalog_version]": "2026-11-03.v1",
            "metadata[plan_key]": "founder-pilot",
            payment_behavior: "error_if_incomplete",
          },
          `gradia-acc-${runId}-subscription`
        )
      )
      subId = str(created.id)
      mustPass(subId !== null && created.livemode === false, "subscription_not_created")
      owned.add(subId as string)
      const sub = await readSub()
      mustPass(evaluateSubscriptionItems(record(sub.items).data).ok, "subscription_items_not_exact")
      mustPass(sub.status === "active", "subscription_not_active")
    })

    // 5. REAL subscription object through the production webhook normalization (+ negative controls).
    await step("webhook_normalization_exact_items", async () => {
      const sub = await readSub()
      const facts = normalize(sub, "customer.subscription.created")
      mustPass(facts.price_lookup_key === SANDBOX_BASE_PRICE.lookupKey, "exact_items_not_accepted")
      mustPass(facts.status === "active", "status_not_active")
      const items = arr(record(sub.items).data)
      const without = normalize({ ...sub, items: { data: items.slice(1) } })
      const extra = normalize({ ...sub, items: { data: [...items, items[0]] } })
      mustPass(without.price_lookup_key === "invalid_items" && extra.price_lookup_key === "invalid_items", "mismatch_not_refused")
    })

    // 6. First activation period: starts at activation (the clock's start), one month long.
    await step("first_period", async () => {
      const sub = await readSub()
      const facts = normalize(sub)
      const start = Date.parse(String(facts.period_start)) / 1000
      const end = Date.parse(String(facts.period_end)) / 1000
      mustPass(Number.isFinite(start) && Number.isFinite(end), "period_unverified")
      // The first period begins at activation: the clock's start, exactly (not a calendar month).
      mustPass(start === frozenTime, "period_not_at_activation")
      const days = (end - start) / 86_400
      mustPass(days >= 28 && days <= 31, "period_not_one_month")
      periodEnd = end
      return { numbers: { periodDays: Math.round(days) } }
    })

    // 7. Usage reaches Stripe BEFORE the renewal invoice finalizes (sent while the clock is still in period 1).
    const eventTimestamp = usageStart - 120
    await step("meter_events_sent", async () => {
      const provider = createSettlementProvider(config, request)
      for (const meter of SANDBOX_METERS) {
        const event = {
          eventName: meter.eventName,
          customerId: customerId as string,
          value: String(ACCEPTANCE_USAGE[meter.component]),
          identifier: `gradia-acc-${runId}-${meter.component}`,
          timestampSeconds: eventTimestamp,
        }
        const ack = await provider.submitMeterEvent(event)
        mustPass(verifyMeterAck(ack, { eventName: event.eventName, customerId: event.customerId, value: event.value, identifier: event.identifier }).ok, "meter_ack_mismatch")
      }
      return { numbers: { events: SANDBOX_METERS.length, expectedMeteredCents: ACCEPTANCE_METERED_CENTS } }
    })

    // 8. Stripe processes events asynchronously: poll the provider's own summaries (evidence only).
    await step("meter_usage_visible", async () => {
      const reader = createMeterEvidenceReader(config, request)
      const minute = Math.floor(eventTimestamp / 60) * 60
      let matched = 0
      for (let attempt = 0; attempt < 10 && matched < SANDBOX_METERS.length; attempt += 1) {
        matched = 0
        for (const meter of SANDBOX_METERS) {
          const observed = await reader.readObservedTotal({ eventName: meter.eventName, customerId: customerId as string, startSeconds: minute })
          if (observed === ACCEPTANCE_USAGE[meter.component]) matched += 1
        }
        if (matched < SANDBOX_METERS.length) await sleep(3_000)
      }
      return matched === SANDBOX_METERS.length ? { numbers: { meters: matched } } : { status: "FAIL", code: "usage_not_visible", numbers: { matched } }
    })

    // 9. Upcoming invoice preview must equal base + metered usage (the F1 reconstruction rule).
    await step("invoice_preview", async () => {
      let preview: Record<string, unknown>
      try {
        preview = record(await get("/invoices/create_preview", { customer: customerId as string, subscription: subId as string }))
      } catch (error) {
        // The preview endpoint is not available for this account/API version: a truthful NOT_RUN, never a pass.
        if (error instanceof StripeError && (error.status === 404 || error.status === 400)) return { status: "NOT_RUN", code: "preview_api_unavailable" }
        throw error
      }
      const total = int(preview.total)
      mustPass(total !== null, "preview_unreadable")
      if (total !== expectedTotal) return { status: "FAIL", code: "preview_total_mismatch", numbers: { expectedCents: expectedTotal, observedCents: total as number } }
      return { numbers: { totalCents: total as number } }
    })

    // 10. Renewal: advance past the boundary; the invoice finalizes ~1 h later and must bill base + the usage we sent.
    await step("renewal_invoice_with_usage", async () => {
      await advanceTo(periodEnd + 2 * 3_600)
      const invoice = await renewalInvoice(0)
      mustPass(invoice !== null, "renewal_invoice_missing")
      const i = invoice as Record<string, unknown>
      mustPass(i.status === "paid", "renewal_not_paid")
      const total = int(i.total)
      if (total !== expectedTotal) return { status: "FAIL", code: "renewal_total_mismatch", numbers: { expectedCents: expectedTotal, observedCents: total ?? -1 } }
      return { numbers: { totalCents: total, baseCents: SANDBOX_BASE_PRICE.unitAmountCents, meteredCents: ACCEPTANCE_METERED_CENTS } }
    })

    // 11. Observation (not a pass/fail): usage for the CLOSED period that reaches Stripe after finalization.
    await step("late_usage_after_finalization", async () => {
      const provider = createSettlementProvider(config, request)
      const meter = SANDBOX_METERS.find((m) => m.component === ACCEPTANCE_LATE_EVENT.component)!
      const event = {
        eventName: meter.eventName, customerId: customerId as string, value: String(ACCEPTANCE_LATE_EVENT.value),
        identifier: `gradia-acc-${runId}-late`, timestampSeconds: eventTimestamp + 30,
      }
      try {
        const ack = await provider.submitMeterEvent(event)
        mustPass(verifyMeterAck(ack, { eventName: event.eventName, customerId: event.customerId, value: event.value, identifier: event.identifier }).ok, "meter_ack_mismatch")
      } catch (error) {
        if (error instanceof StripeError && error.status >= 400 && error.status < 500) return { status: "OBSERVED", code: "late_usage_rejected_by_provider" }
        throw error
      }
      return { status: "OBSERVED", code: "late_usage_accepted_billing_effect_checked_on_next_invoice" }
    })

    // 12. Payment failure: a card that attaches but cannot be charged becomes the default; the next renewal fails.
    let failedInvoiceId: string | null = null
    await step("payment_failure_lapse", async () => {
      const bad = record(await post(`/payment_methods/pm_card_chargeCustomerFail/attach`, { customer: customerId as string }))
      const badPm = str(bad.id)
      mustPass(badPm !== null, "failing_card_not_attached")
      owned.add(badPm as string)
      await post(`/customers/${customerId}`, { "invoice_settings[default_payment_method]": badPm as string })
      const sub = await readSub()
      secondPeriodEnd = Date.parse(String(normalize(sub).period_end)) / 1000
      await advanceTo(secondPeriodEnd + 2 * 3_600)
      const after = await readSub()
      mustPass(after.status === "past_due", "subscription_not_past_due")
      const facts = normalize(after)
      mustPass(facts.status === "past_due", "normalization_status_mismatch")
      const invoice = await renewalInvoice(1)
      mustPass(invoice !== null, "renewal_invoice_missing")
      const i = invoice as Record<string, unknown>
      mustPass(i.status === "open" && (int(i.attempt_count) ?? 0) >= 1, "failed_renewal_not_open")
      failedInvoiceId = str(i.id)
      owned.add(failedInvoiceId as string)
      const total = int(i.total)
      // Observation of the late event: the failed renewal carries only the base unless Stripe billed the late event.
      const late = total !== null && total > SANDBOX_BASE_PRICE.unitAmountCents
      const lateStep = steps.find((s) => s.id === "late_usage_after_finalization")
      if (lateStep && lateStep.status === "OBSERVED") lateStep.code = late ? "late_usage_billed_on_next_invoice" : "late_usage_not_billed"
      return { numbers: { invoiceTotalCents: total ?? -1, attempts: int(i.attempt_count) ?? 0 } }
    })

    // 13. Recovery: restore the good card and pay the open invoice; only then is the subscription active again.
    await step("recovery", async () => {
      mustPass(failedInvoiceId !== null && visaPm !== null, "recovery_prerequisite_missing")
      await post(`/customers/${customerId}`, { "invoice_settings[default_payment_method]": visaPm as string })
      const paid = record(await post(`/invoices/${failedInvoiceId}/pay`, { payment_method: visaPm as string }))
      mustPass(paid.status === "paid", "recovery_invoice_not_paid")
      const sub = await readSub()
      mustPass(sub.status === "active", "subscription_not_active_after_recovery")
      mustPass(normalize(sub).status === "active", "normalization_status_mismatch")
    })

    // 14. The next period starts exactly where the previous one ended (no gap, no overlap), one month later.
    await step("next_period", async () => {
      const sub = await readSub()
      const facts = normalize(sub)
      const start = Date.parse(String(facts.period_start)) / 1000
      const end = Date.parse(String(facts.period_end)) / 1000
      mustPass(secondPeriodEnd > periodEnd && start === secondPeriodEnd, "period_not_contiguous")
      const days = (end - start) / 86_400
      mustPass(days >= 28 && days <= 31, "period_not_one_month")
      return { numbers: { periodsAdvanced: 2 } }
    })

    // 15. Cancellation: the provider says canceled; production normalization sees a terminal status.
    await step("cancellation", async () => {
      await del(`/subscriptions/${subId}`)
      const sub = await readSub()
      mustPass(sub.status === "canceled", "subscription_not_canceled")
      mustPass(normalize(sub, "customer.subscription.deleted").status === "canceled", "normalization_status_mismatch")
    })
  } catch (error) {
    if (!steps.some((s) => s.id === "sandbox_contract")) record_("sandbox_contract", "FAIL", safeCode(error))
    else failed = true
  }

  // Always clean up (even after a failure): expire the open session, delete the clock (cascades to customer + subscription).
  let cleanup: AcceptanceEvidence["cleanup"] = "not_needed"
  try {
    if (sessionId) {
      try {
        await post(`/checkout/sessions/${sessionId}/expire`, {})
      } catch {
        // An already-closed session is fine; the clock deletion below removes the customer regardless.
      }
    }
    if (clockId) {
      await del(`/test_helpers/test_clocks/${clockId}`)
      cleanup = "deleted"
    }
  } catch {
    cleanup = "failed"
    log("CLEANUP_FAILED: delete the simulation named gradia-f2-acceptance-<run> in the Stripe TEST Dashboard")
  }

  markRemainingNotRun()
  withManual()
  const automated = steps.filter((s) => (AUTOMATED_STEPS as readonly string[]).includes(s.id))
  const anyFail = automated.some((s) => s.status === "FAIL")
  const allGood = automated.every((s) => s.status === "PASS" || s.status === "OBSERVED")
  const overall: AcceptanceEvidence["overall"] = anyFail || cleanup === "failed" ? "FAILED" : allGood ? "PASSED" : "INCOMPLETE"
  return finish(overall, cleanup)

  // ---- helpers hoisted below the control flow for readability ----
  async function renewalInvoice(index: number): Promise<Record<string, unknown> | null> {
    const list = record(await get("/invoices", { customer: customerId as string, subscription: subId as string, limit: 20 }))
    const cycle = arr(list.data)
      .map(record)
      .filter((invoice) => invoice.billing_reason === "subscription_cycle" && invoice.livemode === false)
      .sort((a, b) => (int(a.created) ?? 0) - (int(b.created) ?? 0))
    return cycle[index] ?? null
  }
}

/** Human-facing summary of an evidence record: finite codes only. */
export function formatEvidence(evidence: AcceptanceEvidence): string {
  const lines = [`STRIPE TEST-CLOCK ACCEPTANCE: ${evidence.overall}`, `Contract ${evidence.contractVersion} | meter API ${evidence.meterApiVersion} | cleanup: ${evidence.cleanup}`, ""]
  for (const s of evidence.steps) {
    const numbers = s.numbers ? ` ${Object.entries(s.numbers).map(([k, v]) => `${k}=${v}`).join(" ")}` : ""
    lines.push(`  ${s.status.padEnd(8)} ${s.id}${s.code ? ` (${s.code})` : ""}${numbers}`)
  }
  lines.push("", "Not proven by this harness:")
  for (const limitation of evidence.limitations) lines.push(`  - ${limitation}`)
  return lines.join("\n")
}

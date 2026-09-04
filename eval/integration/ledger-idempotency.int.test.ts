import { describe, it, expect, beforeAll, afterAll } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"

import { creditsSpentThisPeriod, recordUsage } from "@/lib/credits"
import { runAutomationForTarget, type AutomationConfig } from "@/lib/automations"
import { isUniqueViolation } from "@/lib/provider-events"
import {
  INTEGRATION,
  INTEGRATION_WITH_SESSION,
  ownerSessionClient,
  serviceClient,
  seedShop,
  cleanup,
  type Seeded,
} from "./_db"

/**
 * P0-005 — ledger idempotency + ledger immutability against REAL Postgres.
 *
 * Proves the two new uniques do what the ticket claims: a replayed provider
 * event can never double-meter usage_events, overlapping crons can never
 * double-fire an automation trigger — with genuinely concurrent inserts on
 * separate connections (Promise.all, never sequential simulation) — and the
 * three ledgers (usage_events, payments, shop_metrics) are SELECT-only for
 * owner sessions (D-024).
 */

const OWNER_PASSWORD = "int-p0005-Ledger0!"

let sb: SupabaseClient
let sb2: SupabaseClient
let seed: Seeded

const ref = (label: string) =>
  `${label}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`

describe.skipIf(!INTEGRATION)("ledger idempotency [integration]", () => {
  beforeAll(async () => {
    sb = serviceClient()
    sb2 = serviceClient()
    seed = await seedShop(sb, { password: OWNER_PASSWORD })
  })

  afterAll(async () => {
    if (sb && seed) await cleanup(sb, seed)
  })

  it("replayed usage event (same vendor_ref) is a clean no-op — one row, balance unchanged", async () => {
    const vendorRef = ref("CA-voice")
    await recordUsage(sb, seed.shopId, "voice_minute", {
      quantity: 3,
      credits: 45,
      vendorRef,
    })
    const shop = { id: seed.shopId, credit_period_start: "1970-01-01T00:00:00Z" }
    const spentAfterFirst = await creditsSpentThisPeriod(sb, shop)

    // The provider retries: identical metering write. Must not throw and
    // must not double-bill — and (P0-006 strengthening) the caller can now
    // SEE that it was an idempotent duplicate, not a fresh write.
    await expect(
      recordUsage(sb, seed.shopId, "voice_minute", {
        quantity: 3,
        credits: 45,
        vendorRef,
      })
    ).resolves.toBe("duplicate")

    const { count } = await sb
      .from("usage_events")
      .select("*", { count: "exact", head: true })
      .eq("shop_id", seed.shopId)
      .eq("vendor_ref", vendorRef)
    expect(count).toBe(1)
    expect(await creditsSpentThisPeriod(sb, shop)).toBe(spentAfterFirst)
  })

  it("concurrent duplicate metering on separate connections → exactly one row", async () => {
    for (let round = 0; round < 5; round++) {
      const vendorRef = ref(`CA-race-${round}`)
      await Promise.all([
        recordUsage(sb, seed.shopId, "voice_minute", { quantity: 1, credits: 15, vendorRef }),
        recordUsage(sb2, seed.shopId, "voice_minute", { quantity: 1, credits: 15, vendorRef }),
      ])
      const { count } = await sb
        .from("usage_events")
        .select("*", { count: "exact", head: true })
        .eq("shop_id", seed.shopId)
        .eq("vendor_ref", vendorRef)
      expect(count).toBe(1)
    }
  })

  it("different vendor refs and different kinds meter independently; tenants never collide", async () => {
    const shared = ref("CA-shared")
    const seedB = await seedShop(sb)
    try {
      // Same (kind, vendor_ref) for two tenants: both must land (shop_id is
      // part of the unique) — tenant A can never block tenant B.
      await recordUsage(sb, seed.shopId, "sms_segment", { credits: 4, vendorRef: shared })
      await recordUsage(sb2, seedB.shopId, "sms_segment", { credits: 4, vendorRef: shared })
      // Same ref, different kind, same shop: independent meters.
      await recordUsage(sb, seed.shopId, "inbound_classify", { credits: 0, vendorRef: shared })

      const { count } = await sb
        .from("usage_events")
        .select("*", { count: "exact", head: true })
        .eq("vendor_ref", shared)
      expect(count).toBe(3)
    } finally {
      await cleanup(sb, seedB)
    }
  })

  it("automation_runs: two concurrent claims for one trigger → exactly one row", async () => {
    const { data: automation, error } = await sb
      .from("automations")
      .insert({ shop_id: seed.shopId, catalog_key: "lead_revival", enabled: true })
      .select("id")
      .single()
    expect(error).toBeNull()
    const automationId = (automation as { id: string }).id

    for (let round = 0; round < 5; round++) {
      const triggerRef = ref(`fire-${round}`)
      const rowFor = () => ({
        shop_id: seed.shopId,
        automation_id: automationId,
        trigger_ref: triggerRef,
        status: "staged",
        result: {},
      })
      const [a, b] = await Promise.all([
        sb.from("automation_runs").insert(rowFor()),
        sb2.from("automation_runs").insert(rowFor()),
      ])
      const failures = [a.error, b.error].filter(Boolean)
      expect(failures).toHaveLength(1)
      expect(isUniqueViolation(failures[0])).toBe(true)

      const { count } = await sb
        .from("automation_runs")
        .select("*", { count: "exact", head: true })
        .eq("automation_id", automationId)
        .eq("trigger_ref", triggerRef)
      expect(count).toBe(1)
    }
  })

  it("runAutomationForTarget fired concurrently stages once, duplicates exit cleanly", async () => {
    const { data: automation } = await sb
      .from("automations")
      .insert({ shop_id: seed.shopId, catalog_key: "quote_followup", enabled: true })
      .select("id")
      .single()
    const automationId = (automation as { id: string }).id

    const shop = {
      id: seed.shopId,
      owner_id: seed.ownerId,
      name: "Integration Test Shop",
      plan: "active" as const,
      tier: "core" as const,
      trial_ends_at: null,
      voice_addon: false,
      credit_period_start: new Date().toISOString(),
    }
    const config: AutomationConfig = {
      key: "quote_followup",
      automationId,
      enabled: true,
      mode: "approval",
      template: "",
      config: {},
    }
    const triggerRef = ref("quote-followup")
    const target = {
      customerId: null,
      toPhone: "+15035550177",
      customerName: "Idempotent Izzy",
      body: "Just checking in on your quote — want us to hold a slot?",
      triggerRef,
      reason: "Quote follow-up",
    }

    const [a, b] = await Promise.all([
      runAutomationForTarget(sb, shop, config, target),
      runAutomationForTarget(sb2, shop, config, target),
    ])
    // Neither throws to the caller; exactly one stages, the other reports
    // duplicate (fast-path read or constraint — both are clean outcomes).
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    const statuses = [a, b].map((r) => (r.ok ? r.status : "error")).sort()
    expect(statuses).toContain("staged")

    const { count: runCount } = await sb
      .from("automation_runs")
      .select("*", { count: "exact", head: true })
      .eq("automation_id", automationId)
      .eq("trigger_ref", triggerRef)
    expect(runCount).toBe(1)

    const { count: pendingCount } = await sb
      .from("pending_actions")
      .select("*", { count: "exact", head: true })
      .eq("shop_id", seed.shopId)
      .eq("action_type", "send_sms")
      .eq("payload->>source", "automation:quote_followup")
    expect(pendingCount).toBe(1)

    // The winning run row carries the staged card and status.
    const { data: run } = await sb
      .from("automation_runs")
      .select("status, pending_action_id")
      .eq("automation_id", automationId)
      .eq("trigger_ref", triggerRef)
      .single()
    expect((run as { status: string }).status).toBe("staged")
    expect((run as { pending_action_id: string | null }).pending_action_id).toBeTruthy()
  })
})

describe.skipIf(!INTEGRATION_WITH_SESSION)(
  "ledger RLS — SELECT-only for owner sessions [integration]",
  () => {
    let session: SupabaseClient

    beforeAll(async () => {
      sb = serviceClient()
      seed = await seedShop(sb, { password: OWNER_PASSWORD })
      session = await ownerSessionClient(seed.email, OWNER_PASSWORD)

      // Service-role fixtures the session will try (and fail) to tamper with.
      await sb.from("usage_events").insert({
        shop_id: seed.shopId,
        kind: "sms_segment",
        quantity: 1,
        credits: 4,
        vendor_ref: ref("CA-rls"),
      })
      await sb.from("payments").insert({
        shop_id: seed.shopId,
        amount_cents: 25000,
        stripe_invoice_id: ref("in"),
        paid_at: new Date().toISOString(),
      })
      await sb.from("shop_metrics").insert({
        shop_id: seed.shopId,
        period_start: "2026-08-01T00:00:00Z",
        period_end: "2026-08-08T00:00:00Z",
        attributed_revenue_cents: 12300,
      })
    })

    afterAll(async () => {
      await session?.auth.signOut()
      if (sb && seed) await cleanup(sb, seed)
    })

    const LEDGERS = ["usage_events", "payments", "shop_metrics"] as const

    it("owner session can still SELECT every ledger (billing/ROI reads intact)", async () => {
      for (const table of LEDGERS) {
        const { data, error } = await session
          .from(table)
          .select("shop_id")
          .eq("shop_id", seed.shopId)
        expect(error, `${table} select`).toBeNull()
        expect(data?.length, `${table} rows visible`).toBeGreaterThan(0)
      }
    })

    it("owner session INSERT into the ledgers is denied", async () => {
      const inserts: Record<(typeof LEDGERS)[number], Record<string, unknown>> = {
        usage_events: {
          shop_id: seed.shopId,
          kind: "sms_segment",
          quantity: 1,
          credits: -100000, // the tamper motive: negative spend = free credits
        },
        payments: {
          shop_id: seed.shopId,
          amount_cents: 1,
          stripe_invoice_id: "forged",
          paid_at: new Date().toISOString(),
        },
        shop_metrics: {
          shop_id: seed.shopId,
          period_start: "2026-01-01T00:00:00Z",
          period_end: "2026-01-08T00:00:00Z",
          attributed_revenue_cents: 999999,
        },
      }
      for (const table of LEDGERS) {
        const { error } = await session.from(table).insert(inserts[table])
        expect(error, `${table} insert must be denied`).toBeTruthy()
      }
    })

    it("owner session UPDATE/DELETE have no effect; rows stay exactly as written", async () => {
      // With SELECT-only policies PostgREST updates/deletes match zero rows
      // (no error, no effect) — assert the effect, not the error shape.
      await session
        .from("usage_events")
        .update({ credits: -5000 })
        .eq("shop_id", seed.shopId)
      await session.from("payments").update({ amount_cents: 1 }).eq("shop_id", seed.shopId)
      await session
        .from("shop_metrics")
        .update({ attributed_revenue_cents: 0 })
        .eq("shop_id", seed.shopId)
      for (const table of LEDGERS) {
        await session.from(table).delete().eq("shop_id", seed.shopId)
      }

      const { data: usage } = await sb
        .from("usage_events")
        .select("credits")
        .eq("shop_id", seed.shopId)
      expect((usage ?? []).map((r) => (r as { credits: number }).credits)).toEqual([4])
      const { data: pay } = await sb
        .from("payments")
        .select("amount_cents")
        .eq("shop_id", seed.shopId)
      expect((pay ?? []).map((r) => (r as { amount_cents: number }).amount_cents)).toEqual([
        25000,
      ])
      const { data: metrics } = await sb
        .from("shop_metrics")
        .select("attributed_revenue_cents")
        .eq("shop_id", seed.shopId)
      expect(
        (metrics ?? []).map(
          (r) => (r as { attributed_revenue_cents: number }).attributed_revenue_cents
        )
      ).toEqual([12300])
    })

    it("service-role writes remain allowed (webhooks/crons unaffected)", async () => {
      const { error } = await sb.from("usage_events").insert({
        shop_id: seed.shopId,
        kind: "email_send",
        quantity: 1,
        credits: 1,
      })
      expect(error).toBeNull()
    })

    it("cross-tenant: owner session sees only its own ledger rows", async () => {
      const seedB = await seedShop(sb)
      try {
        await sb.from("usage_events").insert({
          shop_id: seedB.shopId,
          kind: "sms_segment",
          quantity: 1,
          credits: 4,
        })
        const { data } = await session
          .from("usage_events")
          .select("shop_id")
          .eq("shop_id", seedB.shopId)
        expect(data ?? []).toHaveLength(0)
      } finally {
        await cleanup(sb, seedB)
      }
    })
  }
)

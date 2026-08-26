import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"

import { executeApproval } from "@/lib/approvals"
import { respondToQuote } from "@/app/actions/quote-response"
import {
  INTEGRATION,
  serviceClient,
  seedShop,
  cleanup,
  type Seeded,
} from "./_db"

/**
 * P0-009 against real Postgres — the proofs a mock can't give: one quote →
 * ONE existing lead → one booked pipeline card (no duplicate lead ever),
 * quote advances to `booked` only after the durable appointment write,
 * expiry is enforced server-side at the mutation boundary, forged
 * cross-tenant refs never resolve, replay/rollback re-runs stay idempotent,
 * concurrent double-accept stages at most one booking, and the public
 * response action is rate limited.
 *
 * Aurinko/drafters/CRM are mocked at the provider boundary (no live vendor
 * in CI); embeddings are disabled (recordInteraction is best-effort).
 */

process.env.NEXT_PUBLIC_GRADIA_CONFLICT_ENFORCEMENT = "true"

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("@/lib/supabase/service", async () => {
  const { serviceClient: sc } = await import("./_db")
  return {
    createServiceClient: () => {
      return sc()
    },
  }
})
vi.mock("@/lib/aurinko", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/aurinko")>()
  return {
    ...original,
    getAccessTokenForShop: vi.fn(async () => "int-test-token"),
    listCalendarEvents: vi.fn(async () => []),
    createCalendarEvent: vi.fn(async () => ({
      id: `ev-int-${Math.random().toString(36).slice(2)}`,
      subject: "x",
      start: null,
      end: null,
      location: null,
    })),
    updateCalendarEventTime: vi.fn(async () => undefined),
    deleteCalendarEvent: vi.fn(async () => undefined),
  }
})
vi.mock("@/lib/sms-drafter", () => ({
  draftBookingConfirmationSms: vi.fn(async () => {
    throw new Error("drafter skipped in integration test")
  }),
}))
vi.mock("@/lib/crm-provider", () => ({
  pushBookingToCrm: vi.fn(async () => undefined),
  pushLeadToCrm: vi.fn(async () => undefined),
}))
vi.mock("@/lib/agent-events", () => ({
  dispatchAgentEvent: vi.fn(async () => undefined),
}))
vi.mock("@/lib/embeddings", () => ({
  EMBEDDING_MODEL: "test-disabled",
  embedText: async () => {
    throw new Error("embeddings disabled in integration test")
  },
  embedTexts: async () => {
    throw new Error("embeddings disabled in integration test")
  },
}))

/** Distinct 2h slots on far-apart days so tests never collide. */
let slotCounter = 0
function freshSlot(): { start: string; end: string } {
  slotCounter += 1
  const base = Date.parse("2032-03-02T17:00:00.000Z") + slotCounter * 72 * 60 * 60_000
  return {
    start: new Date(base).toISOString(),
    end: new Date(base + 2 * 60 * 60_000).toISOString(),
  }
}

type QuoteFixture = {
  customerId: string
  leadId: string
  quoteId: string
  token: string
}

/** Seed customer + lead + a SENT quote linked to the lead, C3b-shaped.
 *  Phones are unique per fixture (customers_shop_phone_unique). */
let phoneCounter = 0
async function seedQuote(
  sb: SupabaseClient,
  seed: Seeded,
  opts: { phone?: string | null; validUntil?: string | null } = {}
): Promise<QuoteFixture> {
  phoneCounter += 1
  const phone =
    opts.phone === undefined
      ? `+1503555${String(1000 + phoneCounter).slice(-4)}`
      : opts.phone
  const { data: cust, error: custErr } = await sb
    .from("customers")
    .insert({
      shop_id: seed.shopId,
      name: "Quinn Quote",
      phone,
      email: `quinn-${phoneCounter}-${Date.now().toString(36)}@example.test`,
    })
    .select("id")
    .single()
  if (custErr || !cust) throw new Error(`seed customer: ${custErr?.message}`)

  const { data: lead, error: leadErr } = await sb
    .from("leads")
    .insert({
      shop_id: seed.shopId,
      customer_id: cust.id,
      customer_name: "Quinn Quote",
      // leads.phone is NOT NULL; the no-phone path keys off the CUSTOMER
      // record (what respondToQuote reads), so a placeholder is fine here.
      phone: phone ?? "+15035550000",
      status: "quoted",
      stage: "quote_sent",
    })
    .select("id")
    .single()
  if (leadErr || !lead) throw new Error(`seed lead: ${leadErr?.message}`)

  const { data: quote, error: quoteErr } = await sb
    .from("quotes")
    .insert({
      shop_id: seed.shopId,
      customer_id: cust.id,
      lead_id: lead.id,
      status: "sent",
      line_items: [
        { service_id: null, name: "Full Detail", base_cents: 25000, price_cents: 25000 },
      ],
      subtotal_cents: 25000,
      discount_cents: 0,
      total_cents: 25000,
      valid_until: opts.validUntil === undefined ? null : opts.validUntil,
      sent_at: new Date().toISOString(),
      created_by: "owner",
    })
    .select("id, public_token")
    .single()
  if (quoteErr || !quote) throw new Error(`seed quote: ${quoteErr?.message}`)
  await sb.from("leads").update({ quote_id: quote.id }).eq("id", lead.id)

  return {
    customerId: cust.id as string,
    leadId: lead.id as string,
    quoteId: quote.id as string,
    token: quote.public_token as string,
  }
}

async function leadRows(
  sb: SupabaseClient,
  shopId: string
): Promise<Array<{ id: string; stage: string | null; stage_history: unknown }>> {
  const { data } = await sb
    .from("leads")
    .select("id, stage, stage_history")
    .eq("shop_id", shopId)
  return (data as Array<{ id: string; stage: string | null; stage_history: unknown }>) ?? []
}

async function quoteStatus(sb: SupabaseClient, quoteId: string): Promise<string> {
  const { data } = await sb.from("quotes").select("status").eq("id", quoteId).single()
  return (data as { status: string }).status
}

async function stagedBookings(
  sb: SupabaseClient,
  shopId: string,
  quoteId: string
): Promise<Array<{ id: string; payload: Record<string, unknown> }>> {
  const { data } = await sb
    .from("pending_actions")
    .select("id, payload")
    .eq("shop_id", shopId)
    .eq("action_type", "book_appointment")
    .eq("payload->>quote_id", quoteId)
  return (data as Array<{ id: string; payload: Record<string, unknown> }>) ?? []
}

describe.skipIf(!INTEGRATION)("P0-009 quote acceptance [integration]", () => {
  let sb: SupabaseClient
  let sb2: SupabaseClient

  beforeAll(async () => {
    sb = serviceClient()
    sb2 = serviceClient()
  })

  describe("accept → approve → ONE lead, booked, quote booked", () => {
    let seed: Seeded
    beforeAll(async () => {
      seed = await seedShop(sb)
    })
    afterAll(async () => {
      if (seed) await cleanup(sb, seed)
    })

    it("the full money path: existing lead reused, no duplicate card, quote reaches booked", async () => {
      const fx = await seedQuote(sb, seed)
      const slot = freshSlot()

      const res = await respondToQuote(fx.token, "accept", slot.start)
      expect(res).toEqual({ ok: true, status: "accepted", bookingStaged: true })
      expect(await quoteStatus(sb, fx.quoteId)).toBe("accepted")

      const staged = await stagedBookings(sb, seed.shopId, fx.quoteId)
      expect(staged).toHaveLength(1)
      expect(staged[0].payload.lead_id).toBe(fx.leadId)

      const before = await leadRows(sb, seed.shopId)
      const approve = await executeApproval(sb, staged[0].id, { userId: seed.ownerId })
      expect(approve.ok).toBe(true)

      // ONE lead total — the quote's original lead, now booked. No duplicate.
      const after = await leadRows(sb, seed.shopId)
      expect(after).toHaveLength(before.length)
      const lead = after.find((l) => l.id === fx.leadId)
      expect(lead?.stage).toBe("booked")

      // Quote row shows the truth, appointment carries both links.
      expect(await quoteStatus(sb, fx.quoteId)).toBe("booked")
      const { data: appt } = await sb
        .from("appointments")
        .select("id, lead_id, quote_id")
        .eq("shop_id", seed.shopId)
        .eq("pending_action_id", staged[0].id)
        .single()
      expect(appt?.lead_id).toBe(fx.leadId)
      expect(appt?.quote_id).toBe(fx.quoteId)
    })

    it("rollback-to-pending re-run: no duplicate lead/appointment/stage history, quote stays booked", async () => {
      const fx = await seedQuote(sb, seed)
      const slot = freshSlot()
      await respondToQuote(fx.token, "accept", slot.start)
      const staged = await stagedBookings(sb, seed.shopId, fx.quoteId)
      expect(staged).toHaveLength(1)
      expect((await executeApproval(sb, staged[0].id, { userId: seed.ownerId })).ok).toBe(true)

      const leadsBefore = await leadRows(sb, seed.shopId)
      const historyBefore = leadsBefore.find((l) => l.id === fx.leadId)?.stage_history

      // Crash-replay window: the claim is re-driven after everything landed.
      await sb
        .from("pending_actions")
        .update({ status: "pending", decided_at: null, decided_by_user: null })
        .eq("id", staged[0].id)
      const replay = await executeApproval(sb, staged[0].id, { userId: seed.ownerId })
      expect(replay.ok).toBe(true)
      expect(replay).toMatchObject({ status: "executed" })

      const leadsAfter = await leadRows(sb, seed.shopId)
      expect(leadsAfter).toHaveLength(leadsBefore.length)
      // Stage move idempotent — no duplicate history entry appended.
      expect(leadsAfter.find((l) => l.id === fx.leadId)?.stage_history).toEqual(historyBefore)
      expect(await quoteStatus(sb, fx.quoteId)).toBe("booked")
      const { count } = await sb
        .from("appointments")
        .select("*", { count: "exact", head: true })
        .eq("shop_id", seed.shopId)
        .eq("pending_action_id", staged[0].id)
      expect(count).toBe(1)
    })

    it("sequential double-submit of accept: second call echoes, stages NOTHING new", async () => {
      const fx = await seedQuote(sb, seed)
      const slot = freshSlot()
      const first = await respondToQuote(fx.token, "accept", slot.start)
      const second = await respondToQuote(fx.token, "accept", slot.start)
      expect(first.ok).toBe(true)
      expect(second).toEqual({ ok: true, status: "accepted", bookingStaged: true })
      expect(await stagedBookings(sb, seed.shopId, fx.quoteId)).toHaveLength(1)
    })

    it("concurrent double-click accept: at most ONE booking staged, both callers get a coherent answer", async () => {
      const fx = await seedQuote(sb, seed)
      const slot = freshSlot()
      const [a, b] = await Promise.all([
        respondToQuote(fx.token, "accept", slot.start),
        respondToQuote(fx.token, "accept", slot.start),
      ])
      expect(a.ok).toBe(true)
      expect(b.ok).toBe(true)
      expect(await stagedBookings(sb, seed.shopId, fx.quoteId)).toHaveLength(1)
      expect(await quoteStatus(sb, fx.quoteId)).toBe("accepted")
    })

    it("no-phone acceptance: honest — nothing staged, timeline note tells the owner", async () => {
      const fx = await seedQuote(sb, seed, { phone: null })
      const slot = freshSlot()
      const res = await respondToQuote(fx.token, "accept", slot.start)
      expect(res).toEqual({ ok: true, status: "accepted", bookingStaged: false })
      expect(await stagedBookings(sb, seed.shopId, fx.quoteId)).toHaveLength(0)
      const { data: notes } = await sb
        .from("interactions")
        .select("id, content, metadata")
        .eq("shop_id", seed.shopId)
        .eq("customer_id", fx.customerId)
        .eq("metadata->>event", "accepted_no_booking")
      expect(notes).toHaveLength(1)
      expect((notes?.[0] as { content: string }).content).toContain("no phone")
    })

    it("decline: correct quote → declined, existing lead → lost, replay harmless, no new lead", async () => {
      const fx = await seedQuote(sb, seed)
      const before = await leadRows(sb, seed.shopId)
      const res = await respondToQuote(fx.token, "decline")
      expect(res).toEqual({ ok: true, status: "declined", bookingStaged: false })
      expect(await quoteStatus(sb, fx.quoteId)).toBe("declined")
      const after = await leadRows(sb, seed.shopId)
      expect(after).toHaveLength(before.length)
      expect(after.find((l) => l.id === fx.leadId)?.stage).toBe("lost")

      const replay = await respondToQuote(fx.token, "decline")
      expect(replay).toEqual({ ok: true, status: "declined", bookingStaged: false })
      expect(await leadRows(sb, seed.shopId)).toHaveLength(before.length)
    })
  })

  describe("expiry — server-enforced at the mutation boundary", () => {
    let seed: Seeded
    beforeAll(async () => {
      seed = await seedShop(sb)
    })
    afterAll(async () => {
      if (seed) await cleanup(sb, seed)
    })

    it("expired quote: accept AND decline refused server-side (stale open tab covered), zero side effects", async () => {
      const fx = await seedQuote(sb, seed, { validUntil: "2020-01-01" })
      const accept = await respondToQuote(fx.token, "accept", freshSlot().start)
      expect(accept.ok).toBe(false)
      const decline = await respondToQuote(fx.token, "decline")
      expect(decline.ok).toBe(false)
      expect(await quoteStatus(sb, fx.quoteId)).toBe("sent")
      expect(await stagedBookings(sb, seed.shopId, fx.quoteId)).toHaveLength(0)
      const lead = (await leadRows(sb, seed.shopId)).find((l) => l.id === fx.leadId)
      expect(lead?.stage).toBe("quote_sent")
    })

    it("boundary: valid_until today still accepts (good THROUGH the day)", async () => {
      const today = new Date().toISOString().slice(0, 10)
      const fx = await seedQuote(sb, seed, { validUntil: today })
      const res = await respondToQuote(fx.token, "accept", null)
      expect(res.ok).toBe(true)
    })

    it("null valid_until never expires", async () => {
      const fx = await seedQuote(sb, seed, { validUntil: null })
      const res = await respondToQuote(fx.token, "accept", null)
      expect(res.ok).toBe(true)
    })

    it("invalid token: refused with zero state changes", async () => {
      const bogus = "ffffffffffffffffffffffffffffffff"
      const res = await respondToQuote(bogus, "accept", freshSlot().start)
      expect(res.ok).toBe(false)
      const short = await respondToQuote("short", "accept")
      expect(short.ok).toBe(false)
    })
  })

  describe("tenant safety — forged refs never cross shops", () => {
    let seedA: Seeded
    let seedB: Seeded
    beforeAll(async () => {
      seedA = await seedShop(sb)
      seedB = await seedShop(sb)
    })
    afterAll(async () => {
      if (seedA) await cleanup(sb, seedA)
      if (seedB) await cleanup(sb, seedB)
    })

    it("a shop-A action carrying shop-B's quote_id/lead_id does NOT resolve them — shop B untouched", async () => {
      const fxB = await seedQuote(sb, seedB)
      const slot = freshSlot()
      // Forge: stage a booking in shop A whose payload points at shop B's rows
      // (what a tampered/stale payload would look like).
      const { data: pending } = await sb
        .from("pending_actions")
        .insert({
          shop_id: seedA.shopId,
          action_type: "book_appointment",
          payload: {
            customer_name: "Mallory",
            phone: "+15035550188",
            car_info: null,
            service: "Full Detail",
            iso_start_time: slot.start,
            duration_minutes: 120,
            timezone: null,
            email: null,
            pin_notes: null,
            source: "quote_page",
            quote_id: fxB.quoteId,
            lead_id: fxB.leadId,
          },
          requested_by: seedA.ownerId,
        })
        .select("id")
        .single()
      const res = await executeApproval(sb, (pending as { id: string }).id, {
        userId: seedA.ownerId,
      })
      expect(res.ok).toBe(true)

      // Shop B's quote and lead are exactly as seeded — nothing crossed over.
      expect(await quoteStatus(sb, fxB.quoteId)).toBe("sent")
      const leadB = (await leadRows(sb, seedB.shopId)).find((l) => l.id === fxB.leadId)
      expect(leadB?.stage).toBe("quote_sent")
      // The booking fell back to creating a lead in shop A only.
      const leadsA = await leadRows(sb, seedA.shopId)
      expect(leadsA.some((l) => l.id === fxB.leadId)).toBe(false)
      const { data: appt } = await sb
        .from("appointments")
        .select("lead_id, quote_id")
        .eq("shop_id", seedA.shopId)
        .eq("pending_action_id", (pending as { id: string }).id)
        .single()
      expect(appt?.lead_id).not.toBe(fxB.leadId)
      expect(appt?.quote_id).toBeNull()
    })
  })

  describe("rate limit — the public response action is burst-guarded", () => {
    let seed: Seeded
    beforeAll(async () => {
      seed = await seedShop(sb)
    })
    afterAll(async () => {
      if (seed) await cleanup(sb, seed)
    })

    it("hammering past the per-shop limit gets refused with a typed result", async () => {
      const fx = await seedQuote(sb, seed, { validUntil: "2020-01-01" })
      // Expired quote so every attempt is a no-side-effect request; the
      // limiter counts them all the same.
      let limited = false
      for (let i = 0; i < 15; i += 1) {
        const res = await respondToQuote(fx.token, "accept")
        expect(res.ok).toBe(false)
        if (!res.ok && /many tries/i.test(res.error)) {
          limited = true
          break
        }
      }
      expect(limited).toBe(true)
    })
  })

  // sb2 kept for parity with the atomicity suite (second real connection);
  // the concurrency test above runs both calls through the pooled client.
  afterAll(async () => {
    void sb2
  })
})

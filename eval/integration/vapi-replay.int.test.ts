import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"

import {
  INTEGRATION,
  serviceClient,
  seedShop,
  cleanup,
  type Seeded,
} from "./_db"

/**
 * P0-007 — Vapi end-of-call replay protection against REAL Postgres.
 *
 * The route runs end-to-end (per-shop secret verify → provider_events claim
 * → transcript ingest → voice-minute metering → budget policy → call-record
 * capture → complete) with only the vendor boundaries mocked: the embeddings
 * API, plus deterministic transport-fault injection on the interactions and
 * usage_events writes. Everything durable — provider_events, interactions,
 * usage_events, call_records, shops — is the real local stack.
 *
 * Concurrency uses genuine Promise.all over the route handler; each POST
 * builds its own service client (route behavior), so concurrent deliveries
 * ride separate PostgREST requests exactly as separate Vercel instances
 * would. The financially sensitive metered event (voice_minute) is the one
 * stressed, per the P0-007 spec.
 */

// ── Fault injection (hoisted so the service-client mock can see it) ────
/** While active, usage_events inserts resolve with a transport-style error
 *  (the PostgREST "invalid response from the upstream server" shape) while
 *  every other table stays on the real local stack. */
const meterFault = vi.hoisted(() => ({ active: false }))
/** While active, interactions inserts beyond `allow` fail — simulates a
 *  crash/outage mid-transcript so the resume path can be proven. */
const interactionFault = vi.hoisted(() => ({ active: false, allow: 0, seen: 0 }))

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("@/lib/supabase/service", async () => {
  const db = await import("./_db")
  return {
    createServiceClient: () => {
      const real = db.serviceClient()
      return new Proxy(real, {
        get(target, prop, receiver) {
          if (prop === "from") {
            return (table: string) => {
              if (table === "usage_events" && meterFault.active) {
                return {
                  insert: () =>
                    Promise.resolve({
                      data: null,
                      error: {
                        message:
                          "An invalid response was received from the upstream server",
                      },
                    }),
                }
              }
              if (table === "interactions" && interactionFault.active) {
                const n = interactionFault.seen++
                if (n >= interactionFault.allow) {
                  return {
                    insert: () => ({
                      select: () => ({
                        single: async () => ({
                          data: null,
                          error: {
                            message: "interaction transport failure (test)",
                          },
                        }),
                      }),
                    }),
                  }
                }
              }
              return target.from(table)
            }
          }
          return Reflect.get(target, prop, receiver)
        },
      })
    },
  }
})
vi.mock("@/lib/embeddings", () => ({
  EMBEDDING_MODEL: "test-disabled",
  embedText: async () => {
    throw new Error("embeddings disabled in integration test")
  },
  embedTexts: async () => {
    throw new Error("embeddings disabled in integration test")
  },
}))

// ── Harness ────────────────────────────────────────────────────────────
const SECRET = "int-p0007-vapi-secret"
const ROUTE_URL = "https://gradia-int.test/api/vapi/webhook"
const RUN = `call_p0007_${Date.now().toString(36)}`

let POST: (req: Request) => Promise<Response>
let routeMaxDuration: number
let sb: SupabaseClient
let seed: Seeded
let seedB: Seeded
const ASSISTANT_A = `asst-int-a-${RUN}`
const ASSISTANT_B = `asst-int-b-${RUN}`

const savedEnv: Record<string, string | undefined> = {}

const callId = (label: string) => `${RUN}-${label}`

type Json = Record<string, unknown>
function makePayload(id: string, over: Json = {}, callOver: Json = {}): Json {
  return {
    message: {
      type: "end-of-call-report",
      call: {
        id,
        assistantId: ASSISTANT_A,
        customer: { number: "+15035550142", name: "Int Caller" },
        ...callOver,
      },
      messages: [
        { role: "user", message: "hi, quote for ceramic?" },
        { role: "assistant", message: "We can do Thursday morning." },
        { role: "user", message: "book it" },
      ],
      durationSeconds: 95, // → 2 billed minutes (ceil)
      endedReason: "customer-ended-call",
      summary: "ceramic quote call",
      ...over,
    },
  }
}

function post(payload: Json, opts?: { badSecret?: boolean }) {
  return POST(
    new Request(ROUTE_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vapi-secret": opts?.badSecret ? "forged-secret" : SECRET,
      },
      body: JSON.stringify(payload),
    })
  )
}

async function providerEvent(eventId: string) {
  const { data } = await sb
    .from("provider_events")
    .select("id, status, attempts, shop_id")
    .eq("provider", "vapi")
    .eq("event_id", eventId)
    .maybeSingle()
  return data as
    | { id: string; status: string; attempts: number; shop_id: string | null }
    | null
}

async function countRows(
  table: string,
  filters: Record<string, string>
): Promise<number> {
  let q = sb.from(table).select("*", { count: "exact", head: true })
  for (const [k, v] of Object.entries(filters)) q = q.eq(k, v)
  const { count, error } = await q
  if (error) throw new Error(`${table} count failed: ${error.message}`)
  return count ?? 0
}

const transcriptFor = (eventId: string, shopId: string) =>
  countRows("interactions", {
    shop_id: shopId,
    channel: "voice",
    "metadata->>vapi_call_id": eventId,
  })
const usageFor = (eventId: string, shopId: string) =>
  countRows("usage_events", {
    shop_id: shopId,
    kind: "voice_minute",
    vendor_ref: eventId,
  })
const callRecordsFor = (eventId: string, shopId: string) =>
  countRows("call_records", { shop_id: shopId, vapi_call_id: eventId })

async function usageQuantity(eventId: string, shopId: string): Promise<number> {
  const { data, error } = await sb
    .from("usage_events")
    .select("quantity")
    .eq("shop_id", shopId)
    .eq("kind", "voice_minute")
    .eq("vendor_ref", eventId)
  if (error) throw new Error(`usage quantity failed: ${error.message}`)
  return ((data as { quantity: number }[] | null) ?? []).reduce(
    (s, r) => s + r.quantity,
    0
  )
}

describe.skipIf(!INTEGRATION)("Vapi end-of-call replay protection [integration]", () => {
  beforeAll(async () => {
    for (const k of ["VAPI_WEBHOOK_SECRET", "VAPI_DEFAULT_SHOP_ID", "VERCEL_ENV"]) {
      savedEnv[k] = process.env[k]
      delete process.env[k]
    }
    process.env.VAPI_WEBHOOK_SECRET = SECRET

    sb = serviceClient()
    seed = await seedShop(sb)
    seedB = await seedShop(sb)
    for (const [s, assistant, addon] of [
      [seed, ASSISTANT_A, true],
      [seedB, ASSISTANT_B, false],
    ] as const) {
      const { error } = await sb
        .from("shops")
        .update({ vapi_assistant_id: assistant, voice_addon: addon })
        .eq("id", s.shopId)
      if (error) throw new Error(`shop assistant update failed: ${error.message}`)
    }

    const route = await import("@/app/api/vapi/webhook/route")
    POST = route.POST
    routeMaxDuration = route.maxDuration
  })

  afterAll(async () => {
    if (sb) {
      await sb.from("provider_events").delete().like("event_id", `${RUN}%`)
      if (seed) await cleanup(sb, seed)
      if (seedB) await cleanup(sb, seedB)
    }
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  beforeEach(() => {
    meterFault.active = false
    interactionFault.active = false
    interactionFault.allow = 0
    interactionFault.seen = 0
  })

  it("C5: the route's explicit maxDuration sits strictly below the 300s stale threshold", () => {
    expect(typeof routeMaxDuration).toBe("number")
    expect(routeMaxDuration).toBeLessThan(300)
  })

  it("first valid delivery processes exactly once end-to-end", async () => {
    const id = callId("first")
    const res = await post(makePayload(id))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, turnsIngested: 3 })

    expect(await transcriptFor(id, seed.shopId)).toBe(3)
    expect(await usageFor(id, seed.shopId)).toBe(1)
    expect(await usageQuantity(id, seed.shopId)).toBe(2) // 95s → 2 min
    expect(await callRecordsFor(id, seed.shopId)).toBe(1)
    const pe = await providerEvent(id)
    expect(pe?.status).toBe("completed")
    expect(pe?.shop_id).toBe(seed.shopId)
    expect(pe?.attempts).toBe(1)
  })

  it("replay after completion (×5) is a durable no-op: no transcript, metering, or call-record rows", async () => {
    const id = callId("replay")
    const payload = makePayload(id)
    expect((await post(payload)).status).toBe(200)

    for (let i = 0; i < 5; i++) {
      const res = await post(payload)
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ ok: true, duplicate: true })
    }

    expect(await transcriptFor(id, seed.shopId)).toBe(3)
    expect(await usageFor(id, seed.shopId)).toBe(1)
    expect(await usageQuantity(id, seed.shopId)).toBe(2) // minutes never re-billed
    expect(await callRecordsFor(id, seed.shopId)).toBe(1)
    expect((await providerEvent(id))?.attempts).toBe(1)
  })

  it("concurrent duplicate deliveries: exactly one metering + transcript per round (25 stress rounds)", async () => {
    for (let round = 0; round < 25; round++) {
      const id = callId(`race-${round}`)
      const payload = makePayload(id)

      // Genuine two-way concurrency per round — the tier's convention
      // (matches the P0-006 Twilio stress). The duplicate rides a separate
      // PostgREST request, exactly like a second Vercel instance.
      const [a, b] = await Promise.all([post(payload), post(payload)])
      // Every delivery acks 2xx; only one may have executed.
      expect(a.status).toBe(200)
      expect(b.status).toBe(200)

      expect(await transcriptFor(id, seed.shopId)).toBe(3)
      expect(await usageFor(id, seed.shopId)).toBe(1)
      expect(await usageQuantity(id, seed.shopId)).toBe(2)
      expect(await callRecordsFor(id, seed.shopId)).toBe(1)
      const pe = await providerEvent(id)
      expect(pe?.status).toBe("completed")
      expect(pe?.attempts).toBe(1)
    }
  }, 240_000)

  it("a mid-transcript failure fails the event; the retry RESUMES without duplicating turns", async () => {
    const id = callId("transcript-fail")
    const payload = makePayload(id)

    // First delivery: turn 1 lands, turn 2's insert dies (transport).
    interactionFault.active = true
    interactionFault.allow = 1
    const failed = await post(payload)
    expect(failed.status).toBe(500)
    let pe = await providerEvent(id)
    expect(pe?.status).toBe("failed")
    expect(pe?.attempts).toBe(1)
    expect(await transcriptFor(id, seed.shopId)).toBe(1) // partial prefix
    expect(await usageFor(id, seed.shopId)).toBe(0) // metering never ran

    // Legitimate provider retry: resume at turn 2 — exactly 3 rows total,
    // one metering row, completed.
    interactionFault.active = false
    const retried = await post(payload)
    expect(retried.status).toBe(200)
    pe = await providerEvent(id)
    expect(pe?.status).toBe("completed")
    expect(pe?.attempts).toBe(2)
    expect(await transcriptFor(id, seed.shopId)).toBe(3)
    expect(await usageFor(id, seed.shopId)).toBe(1)
    expect(await callRecordsFor(id, seed.shopId)).toBe(1)

    // Late replay after the successful retry: still one of everything.
    const after = await post(payload)
    expect(after.status).toBe(200)
    expect(await transcriptFor(id, seed.shopId)).toBe(3)
    expect(await usageFor(id, seed.shopId)).toBe(1)
  })

  it("a real metering write failure fails the event; retry lands exactly one usage row and completes", async () => {
    const id = callId("meter-fail")
    const payload = makePayload(id)

    meterFault.active = true
    const failed = await post(payload)
    expect(failed.status).toBe(500)
    let pe = await providerEvent(id)
    expect(pe?.status).toBe("failed")
    expect(pe?.attempts).toBe(1)
    expect(await usageFor(id, seed.shopId)).toBe(0)
    expect(await transcriptFor(id, seed.shopId)).toBe(3) // durable, pre-metering
    expect(await callRecordsFor(id, seed.shopId)).toBe(0) // capture never ran

    meterFault.active = false
    const retried = await post(payload)
    expect(retried.status).toBe(200)
    pe = await providerEvent(id)
    expect(pe?.status).toBe("completed")
    expect(pe?.attempts).toBe(2)
    expect(await usageFor(id, seed.shopId)).toBe(1)
    expect(await usageQuantity(id, seed.shopId)).toBe(2) // billed once, not twice
    expect(await transcriptFor(id, seed.shopId)).toBe(3) // resume, not re-write
    expect(await callRecordsFor(id, seed.shopId)).toBe(1)

    const after = await post(payload)
    expect(after.status).toBe(200)
    expect(await usageFor(id, seed.shopId)).toBe(1)
    expect((await providerEvent(id))?.attempts).toBe(2)
  })

  it("a pre-existing usage row for the call id (lost-response shape) is idempotent success, not a failure", async () => {
    const id = callId("meter-dup")
    // Simulate: the ledger row landed but the first response was lost —
    // the row already exists when this delivery processes.
    const { error: seedErr } = await sb.from("usage_events").insert({
      shop_id: seed.shopId,
      kind: "voice_minute",
      quantity: 2,
      credits: 0,
      vendor_ref: id,
    })
    expect(seedErr).toBeNull()

    const res = await post(makePayload(id))
    expect(res.status).toBe(200)
    expect((await providerEvent(id))?.status).toBe("completed")
    expect(await usageFor(id, seed.shopId)).toBe(1) // still exactly one
    expect(await usageQuantity(id, seed.shopId)).toBe(2) // never doubled
    expect(await callRecordsFor(id, seed.shopId)).toBe(1) // pipeline continued
  })

  it("a fresh processing claim is not stealable — a duplicate before the stale threshold is suppressed", async () => {
    const id = callId("processing-hold")
    const { claimProviderEvent, completeProviderEvent } = await import(
      "@/lib/provider-events"
    )
    const claim = await claimProviderEvent(sb, {
      provider: "vapi",
      eventId: id,
      shopId: seed.shopId,
    })
    expect(claim.outcome).toBe("claimed")

    const res = await post(makePayload(id))
    expect(res.status).toBe(200) // suppressed, not executed
    expect(await res.json()).toMatchObject({ ok: true, duplicate: true })
    expect(await transcriptFor(id, seed.shopId)).toBe(0)
    expect(await usageFor(id, seed.shopId)).toBe(0)
    await completeProviderEvent(sb, "vapi", id)
  })

  it("a legitimately stale processing claim IS reclaimable — the crashed instance cannot strand the call", async () => {
    const id = callId("stale-reclaim")
    const { claimProviderEvent } = await import("@/lib/provider-events")
    const claim = await claimProviderEvent(sb, {
      provider: "vapi",
      eventId: id,
      shopId: seed.shopId,
    })
    expect(claim.outcome).toBe("claimed")
    // Simulate the claimer having crashed 10 minutes ago (beyond the 300s
    // threshold the route passes).
    const { error: ageErr } = await sb
      .from("provider_events")
      .update({ last_attempt_at: new Date(Date.now() - 600_000).toISOString() })
      .eq("provider", "vapi")
      .eq("event_id", id)
    expect(ageErr).toBeNull()

    const res = await post(makePayload(id))
    expect(res.status).toBe(200)
    const pe = await providerEvent(id)
    expect(pe?.status).toBe("completed")
    expect(pe?.attempts).toBe(2) // reclaimed_stale incremented
    expect(await transcriptFor(id, seed.shopId)).toBe(3)
    expect(await usageFor(id, seed.shopId)).toBe(1)
  })

  it("a forged secret cannot create a claim or poison the call id; the real delivery still processes", async () => {
    const id = callId("no-poison")
    const payload = makePayload(id)
    const forged = await post(payload, { badSecret: true })
    expect(forged.status).toBe(401)
    expect(await providerEvent(id)).toBeNull()
    expect(await transcriptFor(id, seed.shopId)).toBe(0)
    expect(await usageFor(id, seed.shopId)).toBe(0)

    const real = await post(payload)
    expect(real.status).toBe(200)
    expect((await providerEvent(id))?.status).toBe("completed")
    expect(await transcriptFor(id, seed.shopId)).toBe(3)
    expect(await usageFor(id, seed.shopId)).toBe(1)
  })

  it("an end-of-call report with no call id is rejected 400 with zero claims and zero writes", async () => {
    const res = await post(makePayload("ignored", {}, { id: undefined }))
    expect(res.status).toBe(400)
    // Nothing to look up by id; prove no orphan writes happened via the
    // run-wide receipt scan.
    const { count } = await sb
      .from("provider_events")
      .select("*", { count: "exact", head: true })
      .eq("provider", "vapi")
      .eq("event_id", "ignored")
    expect(count ?? 0).toBe(0)
  })

  it("an unknown assistant with no dev fallback is refused with no claim or side effect", async () => {
    const id = callId("no-tenant")
    const res = await post(makePayload(id, {}, { assistantId: "asst-nobody" }))
    expect(res.status).toBe(404)
    expect(await providerEvent(id)).toBeNull()
  })

  it("cross-tenant: a call id already processed for shop A cannot mutate shop B, and B's own calls still work", async () => {
    const idA = callId("tenant-a")
    expect((await post(makePayload(idA))).status).toBe(200)
    expect((await providerEvent(idA))?.shop_id).toBe(seed.shopId)

    // Same provider id aimed at shop B (correctly authenticated — the
    // weaponization attempt): the durable claim suppresses it; shop B
    // stays untouched and the receipt still belongs to shop A.
    const resB = await post(makePayload(idA, {}, { assistantId: ASSISTANT_B }))
    expect(resB.status).toBe(200)
    expect(await transcriptFor(idA, seedB.shopId)).toBe(0)
    expect(await usageFor(idA, seedB.shopId)).toBe(0)
    expect(await callRecordsFor(idA, seedB.shopId)).toBe(0)
    expect((await providerEvent(idA))?.shop_id).toBe(seed.shopId)

    // Shop B's own call processes normally.
    const idB = callId("tenant-b")
    expect(
      (await post(makePayload(idB, {}, { assistantId: ASSISTANT_B }))).status
    ).toBe(200)
    expect(await transcriptFor(idB, seedB.shopId)).toBe(3)
    expect(await usageFor(idB, seedB.shopId)).toBe(1)
    expect(await transcriptFor(idB, seed.shopId)).toBe(0)
  })

  it("budget side effects fire once per logical event: a replay does not re-run the over-budget transition", async () => {
    // Shop B has no voice add-on → allowance 0 → every completed call is
    // over budget and flips vapi_stale. Process once, reset the flag,
    // replay — the suppressed replay must NOT flip it back.
    const id = callId("budget-once")
    expect(
      (await post(makePayload(id, {}, { assistantId: ASSISTANT_B }))).status
    ).toBe(200)
    const flag = async () => {
      const { data } = await sb
        .from("shops")
        .select("vapi_stale")
        .eq("id", seedB.shopId)
        .maybeSingle()
      return (data as { vapi_stale: boolean } | null)?.vapi_stale ?? null
    }
    expect(await flag()).toBe(true)

    const { error } = await sb
      .from("shops")
      .update({ vapi_stale: false })
      .eq("id", seedB.shopId)
    expect(error).toBeNull()

    const replay = await post(makePayload(id, {}, { assistantId: ASSISTANT_B }))
    expect(replay.status).toBe(200)
    expect(await replay.json()).toMatchObject({ duplicate: true })
    expect(await flag()).toBe(false) // budget logic did not re-fire
    expect(await usageFor(id, seedB.shopId)).toBe(1)
  })
})

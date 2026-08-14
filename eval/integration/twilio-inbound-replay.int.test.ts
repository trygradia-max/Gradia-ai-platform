import { createHmac } from "node:crypto"
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
 * P0-006 — Twilio inbound replay protection against REAL Postgres.
 *
 * The route runs end-to-end (signature verify → provider_events claim →
 * customer/interaction/consent/classify/stage/meter → complete) with only
 * the vendor boundaries mocked: the Claude classifier (counted, failable),
 * the SMS drafter, Slack posts, knowledge RAG, and the embeddings API.
 * Everything durable — provider_events, interactions, customers,
 * pending_actions, usage_events, rate_limits — is the real local stack.
 *
 * Concurrency uses genuine Promise.all over the route handler; each POST
 * builds its own service client (route behavior), so concurrent deliveries
 * ride separate PostgREST requests exactly as separate Vercel instances
 * would.
 */

// ── Mocked boundaries ──────────────────────────────────────────────────
const cls = vi.hoisted(() => ({
  calls: 0,
  fail: false,
  isLead: true,
}))

/** Deterministic metering-fault injection: while active, any insert into
 *  usage_events resolves with a transport-style error — exactly the
 *  PostgREST "invalid response from the upstream server" failure CI hit —
 *  while every other table stays on the real local stack. */
const meterFault = vi.hoisted(() => ({ active: false }))

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("next/headers", () => ({ headers: async () => new Headers() }))
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
              return target.from(table)
            }
          }
          return Reflect.get(target, prop, receiver)
        },
      })
    },
  }
})
vi.mock("@/lib/sms-classifier", () => ({
  classifySms: async () => {
    cls.calls++
    if (cls.fail) throw new Error("classifier down (test)")
    return {
      is_lead: cls.isLead,
      customer_name: "Int Test",
      service: "ceramic coating",
      vehicle: null,
      summary: "integration inquiry",
    }
  },
}))
vi.mock("@/lib/sms-drafter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sms-drafter")>()),
  draftSmsReply: vi.fn(async () => null),
}))
vi.mock("@/lib/slack", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/slack")>()),
  sendLeadApprovalRequest: vi.fn(async () => {}),
  sendSmsApprovalRequest: vi.fn(async () => {}),
}))
vi.mock("@/lib/knowledge", () => ({
  searchShopKnowledge: vi.fn(async () => []),
  formatKnowledgeForPrompt: vi.fn(() => ""),
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

// ── Harness ────────────────────────────────────────────────────────────
const TOKEN = "int-p0006-twilio-token"
const ROUTE_URL = "https://gradia-int.test/api/twilio/sms"
const RUN = `SMp0006${Date.now().toString(36)}`

let POST: (req: Request) => Promise<Response>
let sb: SupabaseClient
let seed: Seeded
let seedB: Seeded
const SHOP_NUMBER = `+1503555${String(1000 + Math.floor(Math.random() * 8999))}`
const SHOP_B_NUMBER = `+1971555${String(1000 + Math.floor(Math.random() * 8999))}`

const savedEnv: Record<string, string | undefined> = {}

const sid = (label: string) => `${RUN}-${label}`

function sign(url: string, form: URLSearchParams): string {
  let s = url
  for (const k of [...form.keys()].sort()) s += k + (form.get(k) ?? "")
  return createHmac("sha1", TOKEN).update(s).digest("base64")
}

function makeForm(over: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({
    MessageSid: sid("default"),
    AccountSid: "ACinttest",
    From: "+15035550133",
    To: SHOP_NUMBER,
    Body: "how much is a full detail?",
    ...over,
  })
}

function post(form: URLSearchParams, opts?: { badSignature?: boolean }) {
  return POST(
    new Request(ROUTE_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": opts?.badSignature
          ? "forged-signature"
          : sign(ROUTE_URL, form),
      },
      body: form.toString(),
    })
  )
}

async function providerEvent(eventId: string) {
  const { data } = await sb
    .from("provider_events")
    .select("id, status, attempts, shop_id")
    .eq("provider", "twilio")
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

const interactionsFor = (eventId: string, shopId: string) =>
  countRows("interactions", {
    shop_id: shopId,
    channel: "sms",
    "metadata->>twilio_message_sid": eventId,
  })
const pendingFor = (eventId: string, shopId: string) =>
  countRows("pending_actions", {
    shop_id: shopId,
    "payload->>twilio_message_sid": eventId,
  })
const usageFor = (eventId: string, shopId: string) =>
  countRows("usage_events", {
    shop_id: shopId,
    kind: "inbound_classify",
    vendor_ref: eventId,
  })

describe.skipIf(!INTEGRATION)("Twilio inbound replay protection [integration]", () => {
  beforeAll(async () => {
    for (const k of [
      "GRADIA_DASHBOARD_URL",
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "SLACK_BOT_TOKEN",
    ]) {
      savedEnv[k] = process.env[k]
    }
    process.env.GRADIA_DASHBOARD_URL = "https://gradia-int.test"
    process.env.TWILIO_ACCOUNT_SID = "ACinttest"
    process.env.TWILIO_AUTH_TOKEN = TOKEN
    delete process.env.SLACK_BOT_TOKEN

    sb = serviceClient()
    seed = await seedShop(sb)
    seedB = await seedShop(sb)
    for (const [s, num] of [
      [seed, SHOP_NUMBER],
      [seedB, SHOP_B_NUMBER],
    ] as const) {
      const { error } = await sb
        .from("shops")
        .update({ twilio_phone_number: num })
        .eq("id", s.shopId)
      if (error) throw new Error(`shop number update failed: ${error.message}`)
    }

    ;({ POST } = await import("@/app/api/twilio/sms/route"))
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
    cls.calls = 0
    cls.fail = false
    cls.isLead = true
    meterFault.active = false
  })

  it("first valid delivery processes exactly once end-to-end", async () => {
    const id = sid("first")
    const res = await post(makeForm({ MessageSid: id }))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("<Response></Response>")

    expect(cls.calls).toBe(1)
    expect(await interactionsFor(id, seed.shopId)).toBe(1)
    // Drafter is mocked to null, so exactly one staged card: create_lead.
    expect(await pendingFor(id, seed.shopId)).toBe(1)
    const pe = await providerEvent(id)
    expect(pe?.status).toBe("completed")
    expect(pe?.shop_id).toBe(seed.shopId)
    expect(pe?.attempts).toBe(1)
    expect(await usageFor(id, seed.shopId)).toBe(1)
  })

  it("replay after completion (×5) is a durable no-op: no rows, no model calls, same TwiML", async () => {
    const id = sid("replay")
    const form = makeForm({ MessageSid: id })
    expect((await post(form)).status).toBe(200)
    expect(cls.calls).toBe(1)

    for (let i = 0; i < 5; i++) {
      const res = await post(form)
      expect(res.status).toBe(200)
      expect(await res.text()).toContain("<Response></Response>")
    }

    expect(cls.calls).toBe(1) // never re-classified
    expect(await interactionsFor(id, seed.shopId)).toBe(1)
    expect(await pendingFor(id, seed.shopId)).toBe(1)
    expect(await usageFor(id, seed.shopId)).toBe(1)
    expect((await providerEvent(id))?.attempts).toBe(1)
  })

  it("concurrent duplicate deliveries: exactly one execution per round (25 stress rounds)", async () => {
    for (let round = 0; round < 25; round++) {
      const id = sid(`race-${round}`)
      const form = makeForm({ MessageSid: id, Body: `round ${round} inquiry` })
      const before = cls.calls

      const [a, b] = await Promise.all([post(form), post(form)])
      // Winner returns 200; the loser is either suppressed (200) — never
      // a second execution.
      expect(a.status).toBe(200)
      expect(b.status).toBe(200)

      expect(cls.calls - before).toBe(1)
      expect(await interactionsFor(id, seed.shopId)).toBe(1)
      expect(await pendingFor(id, seed.shopId)).toBe(1)
      expect(await usageFor(id, seed.shopId)).toBe(1)
      const pe = await providerEvent(id)
      expect(pe?.status).toBe("completed")
      expect(pe?.attempts).toBe(1)
    }
  }, 240_000)

  it("handler failure marks the event failed; a legitimate retry reprocesses exactly once", async () => {
    const id = sid("fail-retry")
    const form = makeForm({ MessageSid: id })

    cls.fail = true
    const failed = await post(form)
    expect(failed.status).toBe(500)
    let pe = await providerEvent(id)
    expect(pe?.status).toBe("failed")
    expect(pe?.attempts).toBe(1)
    // The inbound message was captured before the classifier died…
    expect(await interactionsFor(id, seed.shopId)).toBe(1)
    // …and the failed attempt still metered the classify cost.
    expect(await usageFor(id, seed.shopId)).toBe(1)

    cls.fail = false
    const retried = await post(form)
    expect(retried.status).toBe(200)
    pe = await providerEvent(id)
    expect(pe?.status).toBe("completed")
    expect(pe?.attempts).toBe(2)
    // Retry reprocessed WITHOUT duplicating anything durable.
    expect(await interactionsFor(id, seed.shopId)).toBe(1)
    expect(await pendingFor(id, seed.shopId)).toBe(1)
    expect(await usageFor(id, seed.shopId)).toBe(1)

    // A completed event can never re-open.
    const after = await post(form)
    expect(after.status).toBe(200)
    expect((await providerEvent(id))?.attempts).toBe(2)
  })

  it("a real metering write failure fails the event; retry lands exactly one usage row and completes", async () => {
    const id = sid("meter-fail")
    const form = makeForm({ MessageSid: id })

    // First delivery: classification happens, but the ledger write hits a
    // transport failure (the CI 502 shape). The event must NOT complete —
    // and nothing downstream of metering may be staged.
    meterFault.active = true
    const failed = await post(form)
    expect(failed.status).toBe(500)
    expect(cls.calls).toBe(1)
    let pe = await providerEvent(id)
    expect(pe?.status).toBe("failed")
    expect(pe?.attempts).toBe(1)
    expect(await usageFor(id, seed.shopId)).toBe(0)
    expect(await pendingFor(id, seed.shopId)).toBe(0) // no card staged
    expect(await interactionsFor(id, seed.shopId)).toBe(1) // durable, pre-metering

    // Legitimate provider retry with metering healthy: exactly one usage
    // row appears, the pipeline finishes, nothing durable duplicates.
    meterFault.active = false
    const retried = await post(form)
    expect(retried.status).toBe(200)
    pe = await providerEvent(id)
    expect(pe?.status).toBe("completed")
    expect(pe?.attempts).toBe(2)
    expect(await usageFor(id, seed.shopId)).toBe(1)
    expect(await interactionsFor(id, seed.shopId)).toBe(1)
    expect(await pendingFor(id, seed.shopId)).toBe(1)

    // Late replay after the successful retry: still one of everything.
    const after = await post(form)
    expect(after.status).toBe(200)
    expect(await usageFor(id, seed.shopId)).toBe(1)
    expect(await pendingFor(id, seed.shopId)).toBe(1)
    expect((await providerEvent(id))?.attempts).toBe(2)
  })

  it("a pre-existing usage row for the sid (unique violation) is idempotent success, not a failure", async () => {
    const id = sid("meter-dup")
    // Simulate the false-negative shape: the ledger row landed but the
    // first response was lost — the row already exists when we process.
    const { error: seedErr } = await sb.from("usage_events").insert({
      shop_id: seed.shopId,
      kind: "inbound_classify",
      quantity: 1,
      credits: 0,
      vendor_ref: id,
    })
    expect(seedErr).toBeNull()

    const res = await post(makeForm({ MessageSid: id }))
    expect(res.status).toBe(200)
    expect((await providerEvent(id))?.status).toBe("completed")
    expect(await usageFor(id, seed.shopId)).toBe(1) // still exactly one
    expect(await pendingFor(id, seed.shopId)).toBe(1) // pipeline continued
  })

  it("a fresh processing claim is not stealable — concurrent reclaim before stale threshold is refused", async () => {
    const id = sid("processing-hold")
    const { claimProviderEvent, completeProviderEvent } = await import(
      "@/lib/provider-events"
    )
    const claim = await claimProviderEvent(sb, {
      provider: "twilio",
      eventId: id,
      shopId: seed.shopId,
    })
    expect(claim.outcome).toBe("claimed")

    const res = await post(makeForm({ MessageSid: id }))
    expect(res.status).toBe(200) // suppressed, not executed
    expect(cls.calls).toBe(0)
    expect(await interactionsFor(id, seed.shopId)).toBe(0)
    await completeProviderEvent(sb, "twilio", id)
  })

  it("STOP applies consent once; replay changes nothing; a NEW STOP (new sid) still processes", async () => {
    cls.isLead = false
    const phone = "+15035550177"
    const id1 = sid("stop-1")
    const form = makeForm({ MessageSid: id1, From: phone, Body: "STOP" })
    expect((await post(form)).status).toBe(200)

    const customer = async () => {
      const { data } = await sb
        .from("customers")
        .select("id, sms_opted_out_at, marketing_consent_at")
        .eq("shop_id", seed.shopId)
        .eq("phone", phone)
        .maybeSingle()
      return data as {
        id: string
        sms_opted_out_at: string | null
        marketing_consent_at: string | null
      } | null
    }
    const afterFirst = await customer()
    expect(afterFirst?.sms_opted_out_at).toBeTruthy()

    // Replay of the SAME MessageSid: consent evaluation must not re-run.
    await new Promise((r) => setTimeout(r, 25))
    expect((await post(form)).status).toBe(200)
    const afterReplay = await customer()
    expect(afterReplay?.sms_opted_out_at).toBe(afterFirst?.sms_opted_out_at)
    expect(await interactionsFor(id1, seed.shopId)).toBe(1)

    // A genuinely new STOP (different sid, same content) processes.
    const id2 = sid("stop-2")
    expect(
      (await post(makeForm({ MessageSid: id2, From: phone, Body: "STOP" }))).status
    ).toBe(200)
    expect(await interactionsFor(id2, seed.shopId)).toBe(1)
    expect((await customer())?.sms_opted_out_at).toBeTruthy()

    // START flips consent back on; a replayed START changes nothing.
    const id3 = sid("start-1")
    const startForm = makeForm({ MessageSid: id3, From: phone, Body: "START" })
    expect((await post(startForm)).status).toBe(200)
    const afterStart = await customer()
    expect(afterStart?.marketing_consent_at).toBeTruthy()
    expect(afterStart?.sms_opted_out_at).toBeNull()
    await new Promise((r) => setTimeout(r, 25))
    expect((await post(startForm)).status).toBe(200)
    const afterStartReplay = await customer()
    expect(afterStartReplay?.marketing_consent_at).toBe(afterStart?.marketing_consent_at)
  })

  it("a forged request cannot create a claim or poison the sid; the real delivery still processes", async () => {
    const id = sid("no-poison")
    const form = makeForm({ MessageSid: id })
    const forged = await post(form, { badSignature: true })
    expect(forged.status).toBe(401)
    expect(await providerEvent(id)).toBeNull()
    expect(await interactionsFor(id, seed.shopId)).toBe(0)

    const real = await post(form)
    expect(real.status).toBe(200)
    expect((await providerEvent(id))?.status).toBe("completed")
    expect(await interactionsFor(id, seed.shopId)).toBe(1)
  })

  it("unknown To number is acknowledged without any claim or side effect", async () => {
    const id = sid("no-tenant")
    const form = makeForm({ MessageSid: id, To: "+19995550000" })
    const res = await post(form)
    expect(res.status).toBe(200)
    expect(await providerEvent(id)).toBeNull()
  })

  it("cross-tenant: a MessageSid already processed for shop A cannot mutate shop B", async () => {
    const idA = sid("tenant-a")
    expect((await post(makeForm({ MessageSid: idA }))).status).toBe(200)
    expect((await providerEvent(idA))?.shop_id).toBe(seed.shopId)

    // Same raw provider id aimed at shop B (MessageSids are globally unique
    // at Twilio — this is the weaponization attempt, correctly signed):
    // the durable claim suppresses it; shop B stays untouched.
    const resB = await post(
      makeForm({ MessageSid: idA, To: SHOP_B_NUMBER, Body: "poisoned replay" })
    )
    expect(resB.status).toBe(200)
    expect(await interactionsFor(idA, seedB.shopId)).toBe(0)
    expect(await pendingFor(idA, seedB.shopId)).toBe(0)
    expect((await providerEvent(idA))?.shop_id).toBe(seed.shopId)

    // Shop B's own traffic is unaffected.
    const idB = sid("tenant-b")
    expect(
      (await post(makeForm({ MessageSid: idB, To: SHOP_B_NUMBER }))).status
    ).toBe(200)
    expect(await interactionsFor(idB, seedB.shopId)).toBe(1)
    expect(await interactionsFor(idB, seed.shopId)).toBe(0)
  })
})

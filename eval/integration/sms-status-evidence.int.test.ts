import { createHmac, randomBytes } from "node:crypto"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { INTEGRATION, serviceClient, seedShop, cleanup, type Seeded } from "./_db"

// Callback-before-interaction recovery (migration 20261021100000), against
// real Postgres. Twilio is a signed request to the real status route; the
// send path's write is the real recordInteraction (memory.ts) or a direct
// insert. Nothing reaches Twilio.

const fault = vi.hoisted(() => ({ evidenceRpc: false }))
vi.mock("next/headers", () => ({ headers: async () => new Headers() }))
vi.mock("@/lib/embeddings", () => ({
  EMBEDDING_MODEL: "test-disabled",
  embedText: async () => { throw new Error("embeddings disabled in integration test") },
  embedTexts: async () => { throw new Error("embeddings disabled in integration test") },
}))
vi.mock("@/lib/supabase/service", async () => {
  const { serviceClient } = await import("./_db")
  return {
    createServiceClient: () => {
      const client = serviceClient()
      return new Proxy(client, {
        get(target, key) {
          if (key === "rpc") {
            return (name: string, args: Record<string, unknown>) =>
              fault.evidenceRpc && name === "record_sms_status_evidence"
                ? Promise.resolve({ data: null, error: { message: "Synthetic database outage" } })
                : target.rpc(name, args)
          }
          const v = Reflect.get(target, key)
          return typeof v === "function" ? v.bind(target) : v
        },
      })
    },
  }
})

const ORIGIN = "https://gradia-int.test"
const TOKEN_A = "synthetic-evidence-token-a"
const TOKEN_B = "synthetic-evidence-token-b"
const sid = () => "SM" + randomBytes(16).toString("hex")

let db: SupabaseClient
let POST: (req: Request) => Promise<Response>
let recordInteraction: typeof import("@/lib/memory").recordInteraction
let a: Seeded, b: Seeded
const saved: Record<string, string | undefined> = {}

function callback(shopId: string, messageSid: string, status: string, token: string, extra: Record<string, string> = {}, signedFor = shopId) {
  const signedUrl = `${ORIGIN}/api/twilio/sms/status?shop=${signedFor}`
  const url = `${ORIGIN}/api/twilio/sms/status?shop=${shopId}`
  const form = new URLSearchParams({ MessageSid: messageSid, MessageStatus: status, ...extra })
  let s = signedUrl
  for (const k of [...form.keys()].sort()) s += k + (form.get(k) ?? "")
  const signature = createHmac("sha1", token).update(s).digest("base64")
  return POST(new Request(url, { method: "POST", body: form.toString(), headers: { "x-twilio-signature": signature, "content-type": "application/x-www-form-urlencoded" } }))
}
/** The send path's write, exactly as approvals / outbound-sms record it. */
async function sendPathRecords(shopId: string, messageSid: string, status = "queued") {
  const res = await recordInteraction(db, {
    shopId, customerId: null, channel: "sms", role: "gradia", content: "Fictional confirmation",
    metadata: { direction: "outbound", twilio_message_sid: messageSid, twilio_status: status, to_phone: "+15551110000" },
  })
  expect(res.ok).toBe(true)
  return (res as { id: string }).id
}
const meta = async (id: string) => (await db.from("interactions").select("metadata").eq("id", id).single()).data!.metadata as Record<string, unknown>
const interactionCount = async (shopId: string) =>
  (await db.from("interactions").select("id", { count: "exact", head: true }).eq("shop_id", shopId)).count ?? 0

beforeAll(async () => {
  if (!INTEGRATION) return
  for (const k of ["GRADIA_DASHBOARD_URL", "ENCRYPTION_KEY", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"]) saved[k] = process.env[k]
  process.env.GRADIA_DASHBOARD_URL = ORIGIN
  process.env.ENCRYPTION_KEY ??= "ab".repeat(32)
  process.env.TWILIO_ACCOUNT_SID = "AC" + "0".repeat(32)
  process.env.TWILIO_AUTH_TOKEN = "synthetic-master-token"
  const { encryptSecret } = await import("@/lib/crypto")
  db = serviceClient()
  a = await seedShop(db); b = await seedShop(db)
  for (const [s, token, n] of [[a, TOKEN_A, "1"], [b, TOKEN_B, "2"]] as const) {
    expect((await db.from("shops").update({ twilio_account_sid_enc: encryptSecret("AC" + n.repeat(32)), twilio_auth_token_enc: encryptSecret(token) }).eq("id", s.shopId)).error).toBeNull()
  }
  ;({ POST } = await import("@/app/api/twilio/sms/status/route"))
  ;({ recordInteraction } = await import("@/lib/memory"))
})
afterAll(async () => {
  if (!INTEGRATION) return
  for (const s of [a, b]) if (s) await cleanup(db, s)
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})
beforeEach(() => { fault.evidenceRpc = false })

describe.skipIf(!INTEGRATION)("SMS status callback before the interaction exists", () => {
  it("an early terminal result is kept and applied when the send path saves the interaction", async () => {
    const m = sid()
    const before = await interactionCount(a.shopId)
    expect((await callback(a.shopId, m, "delivered", TOKEN_A)).status).toBe(200)
    expect(await interactionCount(a.shopId)).toBe(before) // no interaction is fabricated
    const id = await sendPathRecords(a.shopId, m, "queued")
    const after = await meta(id)
    expect(after.twilio_status).toBe("delivered")
    expect(after.twilio_status_evidence_applied_at).toBeTruthy()
  })

  it("duplicate and reordered early callbacks settle on the furthest status; later callbacks still apply", async () => {
    const m = sid()
    for (const status of ["sent", "delivered", "sent", "delivered", "queued"]) {
      expect((await callback(a.shopId, m, status, TOKEN_A)).status).toBe(200)
    }
    const id = await sendPathRecords(a.shopId, m, "queued")
    expect((await meta(id)).twilio_status).toBe("delivered")
    expect((await callback(a.shopId, m, "sent", TOKEN_A)).status).toBe(200) // after the insert: the route's own CAS path
    expect((await meta(id)).twilio_status).toBe("delivered")
  })

  it("conflicting early terminal outcomes keep the first and the contradiction, with its error code", async () => {
    for (const [first, second] of [[["delivered", ""], ["failed", "30008"]], [["undelivered", "30003"], ["delivered", ""]]] as const) {
      const m = sid()
      const send = ([status, code]: readonly [string, string]) => callback(a.shopId, m, status, TOKEN_A, code ? { ErrorCode: code } : {})
      expect((await send(first)).status).toBe(200)
      expect((await send(second)).status).toBe(200)
      const id = await sendPathRecords(a.shopId, m, "queued")
      const after = await meta(id)
      expect(after.twilio_status).toBe(first[0])
      expect(after.twilio_error_code ?? "").toBe(first[1])
      expect(after.twilio_status_conflict).toMatchObject({ status: second[0], error_code: second[1] || null })
    }
  })

  it("an early callback that lands after the send response's status still never moves it backwards", async () => {
    const m = sid()
    expect((await callback(a.shopId, m, "queued", TOKEN_A)).status).toBe(200)
    const id = await sendPathRecords(a.shopId, m, "sent") // the send response already said sent
    expect((await meta(id)).twilio_status).toBe("sent")
  })

  it("cross-business: shop A's signer claiming shop B's SID stores nothing usable for B", async () => {
    const m = sid()
    expect((await callback(a.shopId, m, "failed", TOKEN_A, { ErrorCode: "30007" })).status).toBe(200) // A's own scope
    expect((await callback(b.shopId, m, "failed", TOKEN_A, {}, a.shopId)).status).toBe(401) // A's signature on B's URL
    expect((await callback(b.shopId, m, "failed", TOKEN_A)).status).toBe(401) // A's token for B's shop
    const id = await sendPathRecords(b.shopId, m, "queued")
    const after = await meta(id)
    expect(after.twilio_status).toBe("queued")
    expect(after.twilio_status_evidence_applied_at).toBeUndefined()
  })

  it("an inbound message with the same SID is never touched", async () => {
    const m = sid()
    expect((await callback(a.shopId, m, "delivered", TOKEN_A)).status).toBe(200)
    const res = await recordInteraction(db, { shopId: a.shopId, customerId: null, channel: "sms", role: "customer", content: "Fictional inbound", metadata: { twilio_message_sid: m } })
    expect(res.ok).toBe(true)
    expect((await meta((res as { id: string }).id)).twilio_status).toBeUndefined()
  })

  it("a database outage while storing returns 5xx (Twilio retries) and the retry is kept", async () => {
    const m = sid()
    fault.evidenceRpc = true
    expect((await callback(a.shopId, m, "delivered", TOKEN_A)).status).toBe(500)
    fault.evidenceRpc = false
    expect((await callback(a.shopId, m, "delivered", TOKEN_A)).status).toBe(200)
    const id = await sendPathRecords(a.shopId, m, "queued")
    expect((await meta(id)).twilio_status).toBe("delivered")
  })

  it("a callback racing the send path's insert is never lost (20 rounds, jittered so either can land first)", async () => {
    for (let round = 0; round < 20; round++) {
      const m = sid()
      const jitter = (round % 4) * 15 // 0–45ms: the insert sometimes starts well after the callback
      const [res, id] = await Promise.all([
        callback(a.shopId, m, "delivered", TOKEN_A),
        new Promise((r) => setTimeout(r, jitter)).then(() => sendPathRecords(a.shopId, m, "queued")),
      ])
      expect(res.status).toBe(200)
      expect((await meta(id)).twilio_status, `round ${round}`).toBe("delivered")
    }
  })

  it("a SID that isn't Twilio-shaped is acknowledged and stores nothing", async () => {
    expect((await callback(a.shopId, "SM-not-a-real-sid", "delivered", TOKEN_A)).status).toBe(200)
  })
})

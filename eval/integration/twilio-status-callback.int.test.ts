import { createHmac } from "node:crypto"
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"

import {
  INTEGRATION,
  serviceClient,
  seedShop,
  cleanup,
  type Seeded,
} from "./_db"

/**
 * P0-008 — Twilio SMS delivery-status callback against REAL Postgres.
 *
 * The route runs end-to-end (per-shop credential resolution → signature
 * verify → shop-scoped interaction lookup → metadata update) with nothing
 * mocked but the Next.js request plumbing. Three credential classes are
 * seeded as real encrypted shop rows: a Gradia-provisioned SUBACCOUNT shop
 * (the class the pre-P0-008 route could never verify), a BYO shop, and an
 * env-master shop with no per-shop credentials.
 *
 * The tenant-isolation proof is the point: a tenant signing with their OWN
 * valid token, carrying another tenant's MessageSid, must not be able to
 * touch that tenant's rows — the shop-scoped lookup makes the callback a
 * no-op, verified against actual rows.
 */

vi.mock("next/headers", () => ({ headers: async () => new Headers() }))
vi.mock("@/lib/supabase/service", async () => {
  const db = await import("./_db")
  return { createServiceClient: () => db.serviceClient() }
})

const ORIGIN = "https://gradia-int.test"
const BASE_URL = `${ORIGIN}/api/twilio/sms/status`
const RUN = `SMp0008${Date.now().toString(36)}`

const MASTER_TOKEN = "int-p0008-master-token"
const SUB_TOKEN = "int-p0008-sub-token"
const BYO_TOKEN = "int-p0008-byo-token"

let POST: (req: Request) => Promise<Response>
let sb: SupabaseClient
let subSeed: Seeded // shop A — Gradia-provisioned (subaccount creds)
let byoSeed: Seeded // shop B — BYO creds
let envSeed: Seeded // shop C — no per-shop creds (env master)

const savedEnv: Record<string, string | undefined> = {}

const sid = (label: string) => `${RUN}-${label}`

function sign(url: string, form: URLSearchParams, token: string): string {
  let s = url
  for (const k of [...form.keys()].sort()) s += k + (form.get(k) ?? "")
  return createHmac("sha1", token).update(s).digest("base64")
}

function makeForm(
  messageSid: string,
  over: Record<string, string> = {}
): URLSearchParams {
  return new URLSearchParams({
    MessageSid: messageSid,
    MessageStatus: "delivered",
    To: "+15035550133",
    From: "+16175550100",
    ...over,
  })
}

function post(opts: {
  shopId?: string | null
  form: URLSearchParams
  token: string
  badSignature?: boolean
}) {
  const url = opts.shopId ? `${BASE_URL}?shop=${opts.shopId}` : BASE_URL
  return POST(
    new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": opts.badSignature
          ? "forged-signature"
          : sign(url, opts.form, opts.token),
      },
      body: opts.form.toString(),
    })
  )
}

/** Insert an outbound SMS interaction the way the send path records it. */
async function seedOutbound(
  shopId: string,
  messageSid: string,
  status = "sent"
): Promise<string> {
  const { data, error } = await sb
    .from("interactions")
    .insert({
      shop_id: shopId,
      channel: "sms",
      role: "gradia",
      content: "Your detail is booked for Friday at 9am.",
      metadata: {
        direction: "outbound",
        twilio_message_sid: messageSid,
        twilio_status: status,
        to_phone: "+15035550133",
      },
    })
    .select("id")
    .single()
  if (error || !data) {
    throw new Error(`seedOutbound failed: ${error?.message}`)
  }
  return data.id as string
}

async function metadataOf(id: string): Promise<Record<string, unknown>> {
  const { data, error } = await sb
    .from("interactions")
    .select("metadata")
    .eq("id", id)
    .single()
  if (error || !data) throw new Error(`metadata read failed: ${error?.message}`)
  return (data.metadata as Record<string, unknown>) ?? {}
}

async function interactionCount(shopId: string): Promise<number> {
  const { count, error } = await sb
    .from("interactions")
    .select("*", { count: "exact", head: true })
    .eq("shop_id", shopId)
  if (error) throw new Error(`count failed: ${error.message}`)
  return count ?? 0
}

describe.skipIf(!INTEGRATION)("Twilio status callback repair [integration]", () => {
  beforeAll(async () => {
    for (const k of [
      "GRADIA_DASHBOARD_URL",
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "ENCRYPTION_KEY",
    ]) {
      savedEnv[k] = process.env[k]
    }
    process.env.GRADIA_DASHBOARD_URL = ORIGIN
    process.env.TWILIO_ACCOUNT_SID = "ACintmaster"
    process.env.TWILIO_AUTH_TOKEN = MASTER_TOKEN
    process.env.ENCRYPTION_KEY ??= "ab".repeat(32)

    // encryptSecret reads ENCRYPTION_KEY lazily — import after env is set.
    const { encryptSecret } = await import("@/lib/crypto")

    sb = serviceClient()
    subSeed = await seedShop(sb)
    byoSeed = await seedShop(sb)
    envSeed = await seedShop(sb)

    const updates: Array<[Seeded, Record<string, unknown>]> = [
      [
        subSeed,
        {
          // Gradia-provisioned: active number IS the Gradia number, so the
          // subaccount token signs. BYO columns also present to prove the
          // resolution order picks the subaccount.
          twilio_subaccount_sid: "ACintsub",
          twilio_subaccount_token_enc: encryptSecret(SUB_TOKEN),
          twilio_account_sid_enc: encryptSecret("ACintbyo"),
          twilio_auth_token_enc: encryptSecret(BYO_TOKEN),
          twilio_phone_number: "+16175550100",
          gradia_number_e164: "+16175550100",
        },
      ],
      [
        byoSeed,
        {
          twilio_account_sid_enc: encryptSecret("ACintbyo"),
          twilio_auth_token_enc: encryptSecret(BYO_TOKEN),
          twilio_phone_number: "+15035550177",
        },
      ],
      [envSeed, { twilio_phone_number: "+15035550188" }],
    ]
    for (const [seed, patch] of updates) {
      const { error } = await sb.from("shops").update(patch).eq("id", seed.shopId)
      if (error) throw new Error(`shop cred update failed: ${error.message}`)
    }

    ;({ POST } = await import("@/app/api/twilio/sms/status/route"))
  })

  afterAll(async () => {
    if (sb) {
      for (const seed of [subSeed, byoSeed, envSeed]) {
        if (seed) await cleanup(sb, seed) // shop cascade removes interactions
      }
    }
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it("subaccount shop: a subaccount-signed callback records delivery status (the class that was silently dead)", async () => {
    const id = sid("sub-first")
    const rowId = await seedOutbound(subSeed.shopId, id)

    const res = await post({
      shopId: subSeed.shopId,
      form: makeForm(id),
      token: SUB_TOKEN,
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("<Response></Response>")

    const meta = await metadataOf(rowId)
    expect(meta.twilio_status).toBe("delivered")
    expect(meta.twilio_status_updated_at).toBeTruthy()
    expect(meta.direction).toBe("outbound") // merge preserved existing keys
  })

  it("subaccount shop: master- and BYO-signed requests both reject with zero writes", async () => {
    const id = sid("sub-wrongclass")
    const rowId = await seedOutbound(subSeed.shopId, id)

    for (const token of [MASTER_TOKEN, BYO_TOKEN]) {
      const res = await post({
        shopId: subSeed.shopId,
        form: makeForm(id),
        token,
      })
      expect(res.status).toBe(401)
    }
    expect((await metadataOf(rowId)).twilio_status).toBe("sent")
  })

  it("status lifecycle: sent → delivered applies in order; replaying the terminal callback ×3 is a durable no-op", async () => {
    const id = sid("lifecycle")
    const rowId = await seedOutbound(subSeed.shopId, id, "queued")

    const sent = makeForm(id, { MessageStatus: "sent" })
    expect(
      (await post({ shopId: subSeed.shopId, form: sent, token: SUB_TOKEN })).status
    ).toBe(200)
    expect((await metadataOf(rowId)).twilio_status).toBe("sent")

    const delivered = makeForm(id, { MessageStatus: "delivered" })
    expect(
      (await post({ shopId: subSeed.shopId, form: delivered, token: SUB_TOKEN }))
        .status
    ).toBe(200)
    const after = await metadataOf(rowId)
    expect(after.twilio_status).toBe("delivered")

    for (let i = 0; i < 3; i++) {
      expect(
        (await post({ shopId: subSeed.shopId, form: delivered, token: SUB_TOKEN }))
          .status
      ).toBe(200)
    }
    const replayed = await metadataOf(rowId)
    expect(replayed.twilio_status).toBe("delivered")
    expect(replayed.twilio_error_code).toBeUndefined()
  })

  it("terminal failure records status + ErrorCode", async () => {
    const id = sid("failed")
    const rowId = await seedOutbound(subSeed.shopId, id)

    const res = await post({
      shopId: subSeed.shopId,
      form: makeForm(id, { MessageStatus: "undelivered", ErrorCode: "30003" }),
      token: SUB_TOKEN,
    })
    expect(res.status).toBe(200)
    const meta = await metadataOf(rowId)
    expect(meta.twilio_status).toBe("undelivered")
    expect(meta.twilio_error_code).toBe("30003")
  })

  it("BYO shop: a BYO-signed callback still records status (behavior preserved)", async () => {
    const id = sid("byo-first")
    const rowId = await seedOutbound(byoSeed.shopId, id)

    const res = await post({
      shopId: byoSeed.shopId,
      form: makeForm(id),
      token: BYO_TOKEN,
    })
    expect(res.status).toBe(200)
    expect((await metadataOf(rowId)).twilio_status).toBe("delivered")
  })

  it("env-master shop (?shop= present, no per-shop creds): master-signed callback verifies", async () => {
    const id = sid("env-param")
    const rowId = await seedOutbound(envSeed.shopId, id)

    const res = await post({
      shopId: envSeed.shopId,
      form: makeForm(id),
      token: MASTER_TOKEN,
    })
    expect(res.status).toBe(200)
    expect((await metadataOf(rowId)).twilio_status).toBe("delivered")
  })

  it("legacy callback URL without ?shop=: master-signed callback still lands", async () => {
    const id = sid("env-legacy")
    const rowId = await seedOutbound(envSeed.shopId, id)

    const res = await post({ form: makeForm(id), token: MASTER_TOKEN })
    expect(res.status).toBe(200)
    expect((await metadataOf(rowId)).twilio_status).toBe("delivered")
  })

  it("CROSS-TENANT: shop B, signing with its OWN valid token, cannot mutate shop A's message via A's MessageSid", async () => {
    const id = sid("cross-tenant")
    const rowId = await seedOutbound(subSeed.shopId, id) // belongs to shop A

    // Correctly signed for shop B's URL with shop B's real BYO token — the
    // request authenticates as B, but carries A's MessageSid.
    const before = await interactionCount(byoSeed.shopId)
    const res = await post({
      shopId: byoSeed.shopId,
      form: makeForm(id, { MessageStatus: "failed", ErrorCode: "30007" }),
      token: BYO_TOKEN,
    })
    expect(res.status).toBe(200) // acknowledged, but a scoped no-op

    const meta = await metadataOf(rowId)
    expect(meta.twilio_status).toBe("sent") // A untouched
    expect(meta.twilio_error_code).toBeUndefined()
    expect(await interactionCount(byoSeed.shopId)).toBe(before) // B untouched
  })

  it("query-param manipulation: a signature minted for shop A's URL is invalid on shop B's URL", async () => {
    const id = sid("param-swap")
    await seedOutbound(subSeed.shopId, id)

    const form = makeForm(id)
    const urlA = `${BASE_URL}?shop=${subSeed.shopId}`
    const urlB = `${BASE_URL}?shop=${byoSeed.shopId}`
    const res = await POST(
      new Request(urlB, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-twilio-signature": sign(urlA, form, SUB_TOKEN),
        },
        body: form.toString(),
      })
    )
    expect(res.status).toBe(401)
  })

  it("forged signature: rejected with zero state change", async () => {
    const id = sid("forged")
    const rowId = await seedOutbound(subSeed.shopId, id)

    const res = await post({
      shopId: subSeed.shopId,
      form: makeForm(id),
      token: SUB_TOKEN,
      badSignature: true,
    })
    expect(res.status).toBe(401)
    expect((await metadataOf(rowId)).twilio_status).toBe("sent")
  })

  it("unknown shop id: rejected without falling back to another credential class", async () => {
    const id = sid("unknown-shop")
    const ghost = "00000000-0000-4000-8000-000000000000"
    const res = await post({
      shopId: ghost,
      form: makeForm(id),
      token: MASTER_TOKEN,
    })
    expect(res.status).toBe(404)
  })

  it("unknown MessageSid: signed callback acknowledged with no rows created or mutated", async () => {
    const before = await interactionCount(subSeed.shopId)
    const res = await post({
      shopId: subSeed.shopId,
      form: makeForm(sid("never-sent")),
      token: SUB_TOKEN,
    })
    expect(res.status).toBe(200)
    expect(await interactionCount(subSeed.shopId)).toBe(before)
  })
})

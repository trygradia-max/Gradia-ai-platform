import { createHmac } from "node:crypto"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { leadIntakeInputSchema } from "@/lib/lead-intake"
import {
  chooseMetaLeadPageShop,
  metaLeadAdsIntakeInput,
  parseMetaLeadgenBody,
  readMetaHubChallenge,
  verifyMetaLeadAdsSignature,
} from "@/lib/meta-lead-ads"

const SECRET = "fixture-meta-app-secret"
const TOKEN = "fixture-meta-verify-token"
const SHOP = "00000000-0000-4000-8000-000000000001"
const OTHER = "00000000-0000-4000-8000-000000000002"

function sign(raw: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`
}

function notification(overrides?: {
  pageId?: string
  leadgenId?: string
  formId?: string
  createdTime?: number | string
  shopId?: string
  fieldData?: boolean
}) {
  const pageId = overrides?.pageId ?? "111222333"
  const value: Record<string, unknown> = {
    leadgen_id: overrides?.leadgenId ?? "444555666",
    page_id: pageId,
    form_id: overrides?.formId ?? "777888999",
    created_time: overrides?.createdTime ?? 1710000001,
    ad_id: "ad100",
  }
  if (overrides?.shopId) value.shop_id = overrides.shopId
  if (overrides?.fieldData) {
    value.field_data = [
      { name: "full_name", values: ["Fictional Person"] },
      { name: "phone_number", values: ["+15555550111"] },
      { name: "email", values: ["meta-intake@example.test"] },
    ]
  }
  return {
    object: "page",
    entry: [{
      id: pageId,
      time: 1710000000,
      changes: [{ field: "leadgen", value }],
    }],
  }
}

describe("Meta lead ads signature", () => {
  const raw = JSON.stringify(notification())

  it("accepts the raw-body HMAC and rejects a missing secret", () => {
    expect(verifyMetaLeadAdsSignature(raw, sign(raw), SECRET)).toBe(true)
    expect(verifyMetaLeadAdsSignature(raw, sign(raw).toUpperCase(), SECRET)).toBe(true)
    expect(verifyMetaLeadAdsSignature(raw, sign(raw), null)).toBe(false)
    expect(verifyMetaLeadAdsSignature(raw, sign(raw), "  ")).toBe(false)
    expect(verifyMetaLeadAdsSignature(raw, null, SECRET)).toBe(false)
    expect(verifyMetaLeadAdsSignature(raw, "sha1=abc", SECRET)).toBe(false)
    expect(verifyMetaLeadAdsSignature(raw, "sha256=abcd", SECRET)).toBe(false)
    expect(verifyMetaLeadAdsSignature(raw, sign(raw, "other-secret"), SECRET)).toBe(false)
    expect(verifyMetaLeadAdsSignature(`${raw} `, sign(raw), SECRET)).toBe(false)
  })
})

describe("Meta hub challenge", () => {
  it("echoes the challenge only when the verify token matches", () => {
    expect(readMetaHubChallenge({
      mode: "subscribe",
      verifyToken: TOKEN,
      challenge: "challenge-123",
      configuredToken: TOKEN,
    })).toEqual({ ok: true, challenge: "challenge-123" })
    expect(readMetaHubChallenge({
      mode: "subscribe",
      verifyToken: "nope",
      challenge: "challenge-123",
      configuredToken: TOKEN,
    })).toEqual({ ok: false })
    expect(readMetaHubChallenge({
      mode: "subscribe",
      verifyToken: TOKEN,
      challenge: "challenge-123",
      configuredToken: null,
    })).toEqual({ ok: false })
    expect(readMetaHubChallenge({
      mode: "unsubscribe",
      verifyToken: TOKEN,
      challenge: "challenge-123",
      configuredToken: TOKEN,
    })).toEqual({ ok: false })
    expect(readMetaHubChallenge({
      mode: "subscribe",
      verifyToken: TOKEN,
      challenge: "<script>",
      configuredToken: TOKEN,
    })).toEqual({ ok: false })
  })
})

describe("Meta leadgen parse and page binding", () => {
  it("keeps event ids and drops field data, ads, and a thread", () => {
    const parsed = parseMetaLeadgenBody(notification({ fieldData: true }))
    expect(parsed).toEqual({
      ok: true,
      events: [{
        pageId: "111222333",
        formId: "777888999",
        leadgenId: "444555666",
        createdTime: "1710000001",
        claimedShopId: null,
      }],
    })
    if (!parsed.ok) return
    const mapped = metaLeadAdsIntakeInput({
      shopId: SHOP,
      pageId: parsed.events[0].pageId,
      formId: parsed.events[0].formId,
      leadgenId: parsed.events[0].leadgenId,
      createdTime: parsed.events[0].createdTime,
      receivedAt: "2026-10-02T07:00:00.000Z",
    })
    expect(mapped.threadKey).toBeNull()
    expect(mapped.provider).toBe("meta_lead_ads")
    expect(mapped.channel).toBe("meta")
    expect(mapped.providerEventId).toBe("444555666")
    expect(mapped.payload).toEqual({
      page_id: "111222333",
      form_id: "777888999",
      leadgen_id: "444555666",
      created_time: "1710000001",
    })
    expect(mapped.payload).not.toHaveProperty("phone")
    expect(mapped.payload).not.toHaveProperty("email")
    expect(mapped.payload).not.toHaveProperty("display_name")
    expect(leadIntakeInputSchema.safeParse(mapped).success).toBe(true)
  })

  it("refuses a broken leadgen change, a shop claim that is not a uuid, and disagreeing page ids", () => {
    const missing = notification()
    delete (missing.entry[0].changes[0].value as { leadgen_id?: string }).leadgen_id
    expect(parseMetaLeadgenBody(missing).ok).toBe(false)
    expect(parseMetaLeadgenBody(notification({ shopId: "not-a-shop" })).ok).toBe(false)
    const split = notification()
    split.entry[0].id = "999"
    expect(parseMetaLeadgenBody(split).ok).toBe(false)
    expect(parseMetaLeadgenBody({ object: "user", entry: [] }).ok).toBe(false)
  })

  it("refuses an unknown page, two shops, and a body shop id that disagrees", () => {
    expect(chooseMetaLeadPageShop([], null)).toEqual({
      ok: false,
      status: 404,
      error: "Page is not bound.",
    })
    expect(chooseMetaLeadPageShop([SHOP, OTHER], null)).toEqual({
      ok: false,
      status: 403,
      error: "Page binding is not unique.",
    })
    expect(chooseMetaLeadPageShop([SHOP], OTHER)).toEqual({
      ok: false,
      status: 403,
      error: "Shop binding does not match.",
    })
    expect(chooseMetaLeadPageShop([SHOP], SHOP.toUpperCase())).toEqual({
      ok: true,
      shopId: SHOP,
    })
  })
})

describe("Meta lead ads route guards", () => {
  it("verifies the raw body before parse, binding lookup, or record_lead_intake", () => {
    const route = readFileSync(
      new URL("../src/app/api/intake/meta-lead-ads/route.ts", import.meta.url),
      "utf8",
    )
    const lib = readFileSync(
      new URL("../src/lib/meta-lead-ads.ts", import.meta.url),
      "utf8",
    )
    const sql = readFileSync(
      new URL("../supabase/migrations/20261002075347_meta_lead_page_binding.sql", import.meta.url),
      "utf8",
    )
    const flat = route.replace(/\s+/g, " ")
    const verifyAt = flat.indexOf("verifyMetaLeadAdsSignature(")
    const parseAt = flat.indexOf("JSON.parse(")
    const clientAt = flat.indexOf("createServiceClient(")
    const acceptAt = flat.indexOf("acceptMetaLeadAdsIntake(")
    expect(verifyAt).toBeGreaterThan(-1)
    expect(verifyAt).toBeLessThan(parseAt)
    expect(parseAt).toBeLessThan(clientAt)
    expect(clientAt).toBeLessThan(acceptAt)
    expect(flat.match(/acceptMetaLeadAdsIntake\(/g)).toHaveLength(1)
    expect(lib).toContain('configuredEnv("META_APP_SECRET")')
    expect(lib).toContain('configuredEnv("META_WEBHOOK_VERIFY_TOKEN")')
    expect(lib).toContain("meta_graph_lead_field_retrieval")
    for (const source of [route, lib]) {
      for (const forbidden of [
        "graph.facebook.com",
        "graph.facebook",
        "fetch(",
        "findOrCreateCustomer",
        "facebook_page_id",
        "from(\"customers\")",
        "from(\"leads\")",
        "customer_channel_permissions",
        "pending_actions",
        "fixture-meta-app-secret",
      ]) {
        expect(source.includes(forbidden)).toBe(false)
      }
    }
    expect(sql).toContain("PRIMARY KEY")
    expect(sql).toContain("meta_lead_page_bindings")
    expect(sql).toContain("'page_id', 'form_id', 'leadgen_id', 'created_time'")
    expect(sql).toContain("GRANT SELECT, INSERT, DELETE ON public.meta_lead_page_bindings TO service_role")
    for (const forbidden of [
      "public.customers",
      "public.leads",
      "public.customer_channel_permissions",
      "public.pending_actions",
      "facebook_page_id",
    ]) {
      expect(sql.includes(forbidden)).toBe(false)
    }
  })
})

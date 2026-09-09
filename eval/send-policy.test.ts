import { describe, it, expect } from "vitest"


import { looksOptedIn, looksOptedOut } from "@/lib/agent-audience"
import { evaluateSmsSendPolicy, isQuietHours } from "@/lib/send-policy"

/**
 * Tier 1 — pure/deterministic. Locks the B2 safe-send guardrails: quiet-hours
 * windows, opt-out, and the marketing-consent (consent OR established
 * relationship) gate. All fail closed.
 */

// 2026-06-15T12:00:00Z = 8am America/New_York (EDT, UTC-4) → inside business hrs.
const NOON_UTC = Date.parse("2026-06-15T12:00:00Z")
// 2026-06-15T04:00:00Z = midnight America/New_York → quiet.
const MIDNIGHT_ET = Date.parse("2026-06-15T04:00:00Z")

describe("isQuietHours — overnight window that wraps midnight", () => {
  it("is quiet overnight and open during the day (21→8 in ET)", () => {
    expect(isQuietHours(MIDNIGHT_ET, "America/New_York", 21, 8)).toBe(true)
    expect(isQuietHours(NOON_UTC, "America/New_York", 21, 8)).toBe(false)
  })

  it("falls back gracefully on a bad timezone (never throws in a send)", () => {
    expect(() => isQuietHours(NOON_UTC, "Not/AZone", 21, 8)).not.toThrow()
  })
})

describe("opt-in / opt-out keyword detection", () => {
  it("detects STOP-family and START-family keywords, and ignores plain words", () => {
    expect(looksOptedOut("STOP")).toBe(true)
    expect(looksOptedOut("please unsubscribe me")).toBe(true)
    expect(looksOptedIn("START")).toBe(true)
    expect(looksOptedIn("subscribe please")).toBe(true)
    expect(looksOptedIn("yes I'll be there Tuesday")).toBe(false) // "yes" is not opt-in
  })
})

import { readDb, safeCustomer, safeShop } from "./_tenant-fixtures"
import { evaluateCustomerSendPolicy } from "@/lib/send-policy"
const input = { toPhone: safeCustomer.phone, customerId: "c1", category: "transactional" as const, nowMs: NOON_UTC }
const permission = { shop_id: "shop-1", customer_id: "c1", channel: "sms", destination: safeCustomer.phone, suppressed_at: null, marketing_consent_at: "2026-06-01T00:00:00Z" }

describe("send-time recipient and channel policy", () => {
  it("holds verified recipients during quiet hours", async () => {
    const {db} = readDb({ customers: [safeCustomer] })
    expect(await evaluateSmsSendPolicy(db, safeShop, {...input, nowMs: MIDNIGHT_ET})).toMatchObject({allowed:false, held:true})
  })
  it("permits verified transactional without marketing permission", async () => {
    const {db, reads} = readDb({customers:[safeCustomer]})
    expect(await evaluateSmsSendPolicy(db, safeShop, input)).toMatchObject({allowed:true, customerId:"c1"})
    expect(reads[0].filters).toContainEqual(["shop_id", "shop-1"])
  })
  it.each([
    { ...safeCustomer, shop_id: "shop-2" },
    { ...safeCustomer, id: "foreign" },
    { ...safeCustomer, phone: "+15559998888" },
    { ...safeCustomer, phone: null },
    { ...safeCustomer, sms_opted_out_at: "2026-01-01" },
    { ...safeCustomer, do_not_contact: true },
  ])("blocks missing, foreign, mismatched and suppressed recipients %#", async (customer) => {
    const {db} = readDb({customers:[customer]})
    expect((await evaluateSmsSendPolicy(db, safeShop, input)).allowed).toBe(false)
  })
  it.each(["customers", "customer_channel_permissions"])("fails closed on %s errors", async (table) => {
    const {db} = readDb({customers:[safeCustomer]}, table)
    expect((await evaluateSmsSendPolicy(db, safeShop, input)).allowed).toBe(false)
  })
  it("rejects missing and ambiguous destination-only lookups", async () => {
    for (const customers of [[], [safeCustomer, {...safeCustomer,id:"c2"}]]) {
      const {db} = readDb({customers})
      expect((await evaluateSmsSendPolicy(db,safeShop,{...input,customerId:null})).allowed).toBe(false)
    }
  })
  it("does not infer marketing consent from legacy consent or inbound history", async () => {
    const {db} = readDb({customers:[{...safeCustomer,marketing_consent_at:"2026-01-01"}], interactions:[{id:"i1"}]})
    expect((await evaluateSmsSendPolicy(db,safeShop,{...input,category:"marketing"})).allowed).toBe(false)
  })
  it("requires affirmative destination-bound channel consent and honors suppression", async () => {
    for (const row of [permission, {...permission,channel:"email"}, {...permission,destination:"+15559998888"}, {...permission,suppressed_at:"2026-01-01"}]) {
      const {db} = readDb({customers:[safeCustomer],customer_channel_permissions:[row]})
      expect((await evaluateSmsSendPolicy(db,safeShop,{...input,category:"marketing"})).allowed).toBe(row === permission)
    }
  })
  it("normalizes formatting without guessing another destination", async () => {
    const {db} = readDb({customers:[safeCustomer]})
    expect((await evaluateSmsSendPolicy(db,safeShop,{...input,toPhone:"+1 (555) 111-2222"})).allowed).toBe(true)
    expect((await evaluateSmsSendPolicy(db,safeShop,{...input,toPhone:"5551112222"})).allowed).toBe(false)
  })
  it("binds email to the same customer; DNC and channel suppression apply", async () => {
    for (const customer of [safeCustomer,{...safeCustomer,do_not_contact:true}]) {
      const {db} = readDb({customers:[customer]})
      expect((await evaluateCustomerSendPolicy(db,safeShop,{channel:"email",destination:"SAM@example.test",customerId:"c1",category:"transactional"})).allowed).toBe(!customer.do_not_contact)
      expect((await evaluateCustomerSendPolicy(db,safeShop,{channel:"email",destination:"other@example.test",customerId:"c1",category:"transactional"})).allowed).toBe(false)
    }
    const {db} = readDb({customers:[safeCustomer],customer_channel_permissions:[{...permission,channel:"email",destination:safeCustomer.email,suppressed_at:"2026-01-01"}]})
    expect((await evaluateCustomerSendPolicy(db,safeShop,{channel:"email",destination:safeCustomer.email,customerId:"c1",category:"transactional"})).allowed).toBe(false)
  })
  it("rejects an unknown category and invalid texting timezone", async () => {
    const {db} = readDb({customers:[safeCustomer]})
    expect((await evaluateSmsSendPolicy(db,safeShop,{...input,category:undefined})).allowed).toBe(false)
    expect((await evaluateSmsSendPolicy(db,{...safeShop,timezone:"invalid"},input)).allowed).toBe(false)
  })
})

import { afterEach, describe, expect, it, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { readDb, safeCustomer, safeShop } from "./_tenant-fixtures"
import { initialPolicyDraft } from "@/lib/control-center/drafts"
import { authorizeHumanSmsReply, decideHumanSmsReply, HUMAN_SMS_REPLY_DENIED } from "@/lib/control-center/human-send"
import { sendOperatorSms } from "@/app/actions/outbound-sms"
import { sendOutboundSms } from "@/lib/twilio"
import { recordInteraction } from "@/lib/memory"

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("@/lib/shop", () => ({ requireUser: async () => ({ id: actorId }), requireShop: async () => ({ id: shopId }) }))
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => currentDb }))
vi.mock("@/lib/telephony-provider", async original => ({ ...await original<typeof import("@/lib/telephony-provider")>(), smsGateForShop: () => ({ allowed: true }) }))
vi.mock("@/lib/twilio", async original => ({ ...await original<typeof import("@/lib/twilio")>(), sendOutboundSms: vi.fn() }))
vi.mock("@/lib/memory", async original => ({ ...await original<typeof import("@/lib/memory")>(), recordInteraction: vi.fn() }))

const shopId = "00000000-0000-4000-8000-000000000001"
const actorId = "00000000-0000-4000-8000-000000000002"
const locationId = "00000000-0000-4000-8000-000000000003"
const phone = "+15551112222"
const command = { shopId, actorId, toPhone: phone, body: "On my way" }
const reply = { ...command, locationId, revision: 2, draft: initialPolicyDraft() }
let currentDb: SupabaseClient

function database(overrides: Record<string, unknown> = {}) {
  const rows: Record<string, unknown> = {
    control_policy_active: { shop_id: shopId, revision: 2 },
    shops: { id: shopId, owner_id: actorId },
    shop_memberships: { shop_id: shopId, user_id: actorId, role: "owner", active: true },
    shop_locations: { id: locationId, shop_id: shopId },
    control_policy_history: { shop_id: shopId, location_id: locationId, revision: 2, definition: initialPolicyDraft() },
    ...overrides,
  }
  const from = vi.fn((table: string) => {
    const chain = {
      select: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      maybeSingle: vi.fn(async () => {
        if (rows[table] instanceof Error) throw rows[table]
        return { data: rows[table], error: null }
      }),
    }
    return chain
  })
  return { db: { from } as unknown as SupabaseClient, from }
}

afterEach(() => vi.clearAllMocks())

describe("owner SMS reply policy", () => {
  it("allows the approved default without a second approval", () => {
    expect(decideHumanSmsReply(reply).allowed).toBe(true)
  })

  it("does not treat a workspace-wide Autonomous default as an SMS grant", () => {
    const decision = decideHumanSmsReply({ ...reply, draft: { ...initialPolicyDraft(), workspaceDefault: "autonomous" } })
    expect(decision.allowed).toBe(false)
    expect(decision.reasons).toContain("explicit_autonomy_grant_required")
  })

  it.each([
    { enabled: false },
    { workspaceDefault: "off" as const },
    { workspaceDefault: "suggest" as const },
    { workspaceCeiling: "off" as const },
    { locationCeiling: "off" as const },
    { connectorCeilings: { sms: "off" as const } },
    { actionGrants: { "sms.reply": "off" as const } },
    { actionGrants: { "sms.reply": "suggest" as const } },
    { roleCeilings: { owner: "off" as const } },
    { riskCeilings: { high: "off" as const } },
    { exceptionCeilings: { unknown_identity: "off" as const } },
  ])("refuses an activated restriction %#", patch => {
    expect(decideHumanSmsReply({ ...reply, draft: { ...initialPolicyDraft(), ...patch } }).allowed).toBe(false)
  })

  it("allows an explicit autonomous SMS reply grant", () => {
    const draft = { ...initialPolicyDraft(), actionGrants: { "sms.reply": "autonomous" as const } }
    expect(decideHumanSmsReply({ ...reply, draft }).allowed).toBe(true)
  })

  it("preserves today's send when no policy is active", async () => {
    const { db, from } = database({ control_policy_active: null })
    expect(await authorizeHumanSmsReply(db, { shopId: "shop-1", actorId: "owner", toPhone: phone, body: "Hello" })).toEqual({ allowed: true })
    expect(from).not.toHaveBeenCalledWith("shops")
  })

  it("fails closed when the active policy lookup fails", async () => {
    expect(await authorizeHumanSmsReply(database({ control_policy_active: new Error("private") }).db, command)).toEqual({ allowed: false, reason: HUMAN_SMS_REPLY_DENIED })
  })

  it.each(["shops", "shop_memberships", "shop_locations", "control_policy_history"])("fails closed on missing %s", async table => {
    expect(await authorizeHumanSmsReply(database({ [table]: null }).db, command)).toEqual({ allowed: false, reason: HUMAN_SMS_REPLY_DENIED })
  })

  it("rejects a manager, a stale revision and a foreign location", async () => {
    const cases = [
      { shop_memberships: { shop_id: shopId, user_id: actorId, role: "manager", active: true } },
      { control_policy_history: { shop_id: shopId, location_id: locationId, revision: 1, definition: initialPolicyDraft() } },
      { shop_locations: { id: locationId, shop_id: actorId } },
    ]
    for (const overrides of cases) {
      expect(await authorizeHumanSmsReply(database(overrides).db, command)).toEqual({ allowed: false, reason: HUMAN_SMS_REPLY_DENIED })
    }
  })
})

describe("manual SMS respects the activated policy", () => {
  function shopDb(policy?: Record<string, unknown>) {
    const tables: Record<string, Record<string, unknown>[]> = {
      shops: [{ ...safeShop, id: shopId, owner_id: actorId, twilio_phone_number: "+15550001111" }],
      customers: [{ ...safeCustomer, shop_id: shopId }],
    }
    if (policy) {
      tables.control_policy_active = [{ shop_id: shopId, revision: 2 }]
      tables.shop_memberships = [{ shop_id: shopId, user_id: actorId, role: "owner", active: true }]
      tables.shop_locations = [{ id: locationId, shop_id: shopId }]
      tables.control_policy_history = [{ shop_id: shopId, location_id: locationId, revision: 2, definition: { ...initialPolicyDraft(), ...policy } }]
    }
    const { db, reads } = readDb(tables)
    currentDb = db
    return reads
  }

  it("still reaches the consent gate when nothing is activated", async () => {
    shopDb()
    expect(await sendOperatorSms({ to_phone: phone, body: "Buy our promotion" })).toMatchObject({ ok: false, error: expect.stringContaining("No affirmative consent") })
    expect(sendOutboundSms).not.toHaveBeenCalled()
    expect(recordInteraction).not.toHaveBeenCalled()
  })

  it("stops an off SMS connector before the customer lookup or Twilio", async () => {
    const reads = shopDb({ connectorCeilings: { sms: "off" } })
    expect(await sendOperatorSms({ to_phone: phone, body: "On my way" })).toEqual({ ok: false, error: HUMAN_SMS_REPLY_DENIED })
    expect(reads.map(read => read.table)).not.toContain("customers")
    expect(sendOutboundSms).not.toHaveBeenCalled()
    expect(recordInteraction).not.toHaveBeenCalled()
  })
})

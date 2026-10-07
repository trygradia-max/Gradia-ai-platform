import { beforeEach, describe, expect, it, vi } from "vitest"
import { ACTIONS, modes } from "@/lib/control-center/policy"
import { initialPolicyDraft, policyDraftSchema } from "@/lib/control-center/drafts"
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), shop: vi.fn(), user: vi.fn(), client: vi.fn(), revalidate: vi.fn() }))
vi.mock("@/lib/shop", () => ({ requireShop: mocks.shop, requireUser: mocks.user }))
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.client }))
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }))
import { savePolicyDraft } from "@/app/actions/control-center"
const SHOP = "11111111-1111-4111-8111-111111111111"
describe("policy draft validation and authenticated save", () => {
  beforeEach(() => { vi.resetAllMocks(); mocks.shop.mockResolvedValue({ id: SHOP }); mocks.user.mockResolvedValue({ id: "owner" }); mocks.client.mockResolvedValue({ rpc: mocks.rpc }); mocks.rpc.mockResolvedValue({ data: 2, error: null }) })
  it("initial configuration contains no implicit action grants", () => { expect(policyDraftSchema.parse(initialPolicyDraft()).actionGrants).toEqual({}) })
  it.each(modes)("accepts explicit %s and inherited modes", mode => {
    const definition = initialPolicyDraft()
    definition.actionGrants = Object.fromEntries(Object.keys(ACTIONS).map(key => [key, mode]))
    definition.connectorCeilings = { sms: null, email: mode }
    expect(policyDraftSchema.safeParse(definition).success).toBe(true)
  })
  it.each(["connectorCeilings", "actionGrants", "roleCeilings", "riskCeilings", "exceptionCeilings"] as const)("rejects unknown %s and executable custom rules", scope => {
    expect(policyDraftSchema.safeParse({ ...initialPolicyDraft(), [scope]: { invented: "autonomous" } }).success).toBe(false)
    expect(policyDraftSchema.safeParse({ ...initialPolicyDraft(), [scope]: "return true" }).success).toBe(false)
  })
  it("rejects injected actor, activation and extra fields before accessing the database", async () => {
    for (const extra of [{ actorId: SHOP }, { activated: true }, { definition: { ...initialPolicyDraft(), execute: true } }]) {
      expect((await savePolicyDraft({ shopId: SHOP, expectedRevision: 1, definition: initialPolicyDraft(), ...extra })).ok).toBe(false)
    }
    expect(mocks.client).not.toHaveBeenCalled()
  })
  it("rejects foreign shop selection without RPC", async () => {
    mocks.shop.mockResolvedValue({ id: "22222222-2222-4222-8222-222222222222" })
    expect((await savePolicyDraft({ shopId: SHOP, expectedRevision: 1, definition: initialPolicyDraft() })).ok).toBe(false)
    expect(mocks.client).not.toHaveBeenCalled()
  })
  it("passes only trusted shop, expected revision and validated definition", async () => {
    const definition = initialPolicyDraft()
    expect(await savePolicyDraft({ shopId: SHOP, expectedRevision: 1, definition })).toEqual({ ok: true, revision: 2 })
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("save_control_policy_draft", { p_shop: SHOP, p_expected_revision: 1, p_definition: definition })
    expect(mocks.revalidate).toHaveBeenCalledWith("/control-center")
  })
  it("reports stale saves without silently overwriting", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "PT409" } })
    expect(await savePolicyDraft({ shopId: SHOP, expectedRevision: 1, definition: initialPolicyDraft() })).toMatchObject({ ok: false, error: expect.stringContaining("another session") })
    expect(mocks.revalidate).not.toHaveBeenCalled()
  })
  it("does not disclose database errors or claim an uncertain save succeeded", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "sensitive internal detail" } })
    expect(JSON.stringify(await savePolicyDraft({ shopId: SHOP, expectedRevision: 1, definition: initialPolicyDraft() }))).not.toContain("sensitive")
    mocks.rpc.mockResolvedValue({ data: null, error: null })
    expect((await savePolicyDraft({ shopId: SHOP, expectedRevision: 1, definition: initialPolicyDraft() })).ok).toBe(false)
  })
})

describe("explicit policy activation", () => {
 beforeEach(() => { vi.resetAllMocks(); mocks.shop.mockResolvedValue({ id: SHOP }); mocks.user.mockResolvedValue({ id: "owner" }); mocks.client.mockResolvedValue({ rpc: mocks.rpc }); mocks.rpc.mockResolvedValue({ data: 2, error: null }) })
 it("activates only the reviewed saved revision with a compare-and-swap active revision", async () => {
  const { activatePolicyDraft } = await import("@/app/actions/control-center")
  expect(await activatePolicyDraft({ shopId: SHOP, revision: 2, expectedActive: null })).toEqual({ ok: true, revision: 2 })
  expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("activate_control_policy", { p_shop: SHOP, p_revision: 2, p_expected_active: null })
 })
 it("rejects injected policy, actors, foreign shops and malformed revisions", async () => {
  const { activatePolicyDraft } = await import("@/app/actions/control-center")
  for (const extra of [{ actor: SHOP }, { revision: -1 }, { definition: initialPolicyDraft() }, { shopId: "22222222-2222-4222-8222-222222222222" }]) {
   expect((await activatePolicyDraft({ shopId: SHOP, revision: 2, expectedActive: null, ...extra })).ok).toBe(false)
  }
  expect(mocks.rpc).not.toHaveBeenCalled()
 })
 it("does not report stale, failed or unverifiable activation as success", async () => {
  const { activatePolicyDraft } = await import("@/app/actions/control-center")
  for (const result of [{ data: null, error: { message: "private detail" } }, { data: 3, error: null }]) {
   mocks.rpc.mockResolvedValue(result)
   const r = await activatePolicyDraft({ shopId: SHOP, revision: 2, expectedActive: null })
   expect(r.ok).toBe(false); expect(JSON.stringify(r)).not.toContain("private detail")
  }
 })
})

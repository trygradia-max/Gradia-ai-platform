import { describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { SupabaseClient } from "@supabase/supabase-js"

import { recheckBeforeEffect } from "@/lib/approval-pre-effect"

const ACTION = { id: "11111111-1111-4111-8111-111111111111", shop_id: "22222222-2222-4222-8222-222222222222" }
const client = (reply: () => unknown) => ({ rpc: vi.fn(async () => reply()) }) as unknown as SupabaseClient & { rpc: ReturnType<typeof vi.fn> }

describe("recheckBeforeEffect fails closed", () => {
  it("allows only an explicit ok:true, for the exact action and shop", async () => {
    const db = client(() => ({ data: { ok: true, call_proposal: true }, error: null }))
    expect(await recheckBeforeEffect(db, ACTION)).toEqual({ allowed: true })
    expect(db.rpc).toHaveBeenCalledWith("call_copilot_pre_effect_recheck", { p_shop: ACTION.shop_id, p_action: ACTION.id })
    expect(await recheckBeforeEffect(client(() => ({ data: { ok: true, call_proposal: false }, error: null })), ACTION)).toEqual({ allowed: true })
    expect(await recheckBeforeEffect(client(() => ({ data: JSON.stringify({ ok: true }), error: null })), ACTION)).toEqual({ allowed: true })
  })
  it("maps every database denial to a plain message and never allows it", async () => {
    for (const reason of ["call_consent_unavailable", "call_evidence_changed", "call_crm_state_changed", "call_definition_inactive", "call_requester_revoked", "call_proposal_edited", "call_action_not_claimed", "call_proposal_expired"]) {
      const r = await recheckBeforeEffect(client(() => ({ data: { ok: false, denied: reason }, error: null })), ACTION)
      expect(r).toMatchObject({ allowed: false, reason })
      expect((r as { message: string }).message).toMatch(/Nothing was changed/)
    }
  })
  it("treats an error, a throw, nothing, a null, a string or an ambiguous answer as a denial", async () => {
    const bad: (() => unknown)[] = [
      () => ({ data: null, error: { code: "XX000" } }),
      () => { throw new Error("socket closed") },
      () => ({ data: null, error: null }),
      () => ({ data: undefined, error: null }),
      () => ({ data: "yes", error: null }),
      () => ({ data: { ok: "true" }, error: null }),
      () => ({ data: { ok: false }, error: null }),
      () => ({ data: { denied: "x" }, error: null }),
      () => ({ data: [{ ok: true }], error: null }),
      () => ({ data: { ok: true, denied: undefined, extra: 1 }, error: { code: "42501" } }),
    ]
    for (const reply of bad) {
      expect(await recheckBeforeEffect(client(reply), ACTION), String(reply)).toMatchObject({ allowed: false })
    }
  })
  it("an unmapped denial reason is still a denial", async () => {
    expect(await recheckBeforeEffect(client(() => ({ data: { ok: false, denied: "something_new" }, error: null })), ACTION)).toMatchObject({ allowed: false, reason: "something_new" })
  })
})

describe("approvals.ts asks again immediately before every effect that runs after the claim", () => {
  const src = readFileSync(join(__dirname, "..", "src", "lib", "approvals.ts"), "utf8")
  const body = (name: string): string => {
    const start = src.indexOf(`async function ${name}(`)
    const next = src.indexOf("\nasync function ", start + 10)
    return src.slice(start, next < 0 ? undefined : next)
  }
  it("booking: before the first domain write AND before the authoritative appointment write", () => {
    const b = body("executeBookAppointment")
    const checks = [...b.matchAll(/denyBeforeEffect\(/g)].map((m) => m.index!)
    expect(checks).toHaveLength(2)
    expect(checks[0]).toBeLessThan(b.indexOf("findOrCreateCustomer("))
    expect(checks[1]).toBeGreaterThan(b.indexOf("upsertCustomerVehicle("))
    expect(checks[1]).toBeLessThan(b.indexOf("writeAppointmentSerialized("))
  })
  it("quote draft: before customer resolution, the vehicle upsert and the quote insert", () => {
    const b = body("executeCreateQuote")
    expect(b.indexOf("denyBeforeEffect(")).toBeGreaterThan(0)
    expect(b.indexOf("denyBeforeEffect(")).toBeLessThan(b.indexOf("findOrCreateCustomer("))
    expect(b.indexOf("denyBeforeEffect(")).toBeLessThan(b.indexOf('.from("quotes")'))
  })
  it("text: after the send policy, before any proof is consumed and before the provider is asked", () => {
    const b = body("executeSendSms")
    const at = b.indexOf("denyBeforeEffect(")
    expect(at).toBeGreaterThan(b.indexOf("evaluateSmsSendPolicy("))
    expect(at).toBeLessThan(b.indexOf("serviceActionIsUnspent("))
    expect(at).toBeLessThan(b.indexOf("claimServiceExecution("))
    expect(at).toBeLessThan(b.indexOf("sendOutboundSms("))
  })
  it("a denial releases the claim and returns an error (no effect path continues)", () => {
    const fn = src.slice(src.indexOf("async function denyBeforeEffect("), src.indexOf("async function executeCreateLead("))
    expect(fn).toMatch(/if \(check\.allowed\) return null/)
    expect(fn).toMatch(/await rollbackClaim\(supabase, claimed\)/)
    expect(fn).toMatch(/return \{ ok: false, error: check\.message \}/)
  })
  it("record commands keep their atomic path: they return before any post-claim effect", () => {
    const exec = src.slice(src.indexOf("export async function executeApproval("))
    expect(exec.indexOf("isRecordAction(claimed.action_type)")).toBeLessThan(exec.indexOf("switch (claimed.action_type)"))
    expect(exec).not.toMatch(/isRecordAction[\s\S]{0,300}denyBeforeEffect/)
  })
})

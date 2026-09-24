import { describe, expect, it } from "vitest"
import { ACTIONS, evaluatePolicy, modes, translateLegacyMode, type PolicyInput, type Operation } from "@/lib/control-center/policy"

const SHOP = "11111111-1111-4111-8111-111111111111"
const LOCATION = "22222222-2222-4222-8222-222222222222"
const COMMAND = "33333333-3333-4333-8333-333333333333"
const ACTOR = "44444444-4444-4444-8444-444444444444"
function input(operation: Operation = "sms.reply"): PolicyInput {
  return {
    command: { id: COMMAND, shopId: SHOP, locationId: LOCATION, operation, connector: ACTIONS[operation].connector, intent: "execute", source: "agent", payloadHash: "a".repeat(64), stagedPolicyVersion: 1 },
    policy: { shopId: SHOP, locationId: LOCATION, operation, connector: ACTIONS[operation].connector, version: 1, available: true, enabled: true, workspaceDefault: null, workspaceCeiling: "autonomous", connectorCeiling: "autonomous", actionGrant: null, locationCeiling: null, roleCeiling: null, riskCeiling: null, exceptionCeiling: null },
    actor: { id: ACTOR, shopId: SHOP, locationId: LOCATION, active: true, role: "owner", authorizedOperations: [operation], discountLimit: 0 },
    facts: { tenantReferencesValid: true, safetyPassed: true, ready: true, setupVerified: true, causalActionVerified: true, discountAmount: 0, approval: null },
  }
}
function approve(i: PolicyInput) {
  i.facts.approval = { commandId: i.command.id, payloadHash: i.command.payloadHash, policyVersion: i.policy.version, currentAuthorityVerified: true }
}
describe("Control Center contract (not runtime activation)", () => {
  it.each(Object.keys(ACTIONS) as Operation[])("approved initial behavior for %s", (operation) => {
    const i = input(operation), d = ACTIONS[operation]
    i.command.intent = d.initial === "read" ? "read" : d.initial === "suggest" ? "suggest" : "stage"
    const r = evaluatePolicy(i)
    expect(r.mode).toBe(d.initial)
    expect(r.allowed).toBe(d.initial !== "off")
  })
  it.each(["off", "read", "suggest", "approval", "autonomous"] as const)("mode %s has distinct staging/execution behavior", (m) => {
    const i = input(); i.policy.actionGrant = m
    i.command.intent = "stage"
    expect(evaluatePolicy(i).allowed).toBe(m === "approval" || m === "autonomous")
    i.command.intent = "execute"
    expect(evaluatePolicy(i).allowed).toBe(m === "autonomous")
    approve(i)
    expect(evaluatePolicy(i).allowed).toBe(m === "approval" || m === "autonomous")
  })
  it.each(["workspaceCeiling", "connectorCeiling", "locationCeiling", "roleCeiling", "riskCeiling", "exceptionCeiling"] as const)("every %s limits explicit autonomy", (scope) => {
    for (const m of modes) {
      const i = input(); i.policy.actionGrant = "autonomous"; i.policy[scope] = m
      expect(evaluatePolicy(i).mode).toBe(m)
      expect(evaluatePolicy(i).allowed).toBe(m === "autonomous")
    }
  })
  it("explicit action grants differ from workspace defaults but never ceilings", () => {
    const i = input(); i.policy.workspaceDefault = "approval"; i.policy.actionGrant = "autonomous"
    expect(evaluatePolicy(i).allowed).toBe(true)
    i.policy.workspaceCeiling = "approval"
    expect(evaluatePolicy(i).allowed).toBe(false)
  })
  it("a general autonomous default cannot silently authorize customer actions", () => {
    const i = input(); i.policy.workspaceDefault = "autonomous"
    expect(evaluatePolicy(i).reasons).toContain("explicit_autonomy_grant_required")
  })
  it.each(["tenantReferencesValid", "safetyPassed", "ready"] as const)("approval cannot bypass failed %s", (field) => {
    const i = input(); approve(i); i.facts[field] = false
    expect(evaluatePolicy(i).allowed).toBe(false)
  })
  it.each(["shopId", "locationId"] as const)("wrong %s denies policy and actor scope", (field) => {
    const i = input(); approve(i); i.policy[field] = ACTOR
    expect(evaluatePolicy(i).allowed).toBe(false)
    i.policy[field] = i.command[field]; i.actor[field] = ACTOR
    expect(evaluatePolicy(i).allowed).toBe(false)
  })
  it("unknown fields, actions, modes and missing policy fail closed", () => {
    for (const bad of [null, {}, { ...input(), extra: true }, { ...input(), command: { ...input().command, operation: "send_anything" } }, { ...input(), policy: { ...input().policy, actionGrant: "custom" } }]) expect(evaluatePolicy(bad).allowed).toBe(false)
    const i = input(); i.policy.available = false; approve(i)
    expect(evaluatePolicy(i).reasons).toContain("policy_unavailable")
  })
  it("revocation and policy kill switches apply to waiting approvals", () => {
    const i = input(); approve(i); i.actor.active = false
    expect(evaluatePolicy(i).allowed).toBe(false)
    i.actor.active = true; i.policy.enabled = false
    expect(evaluatePolicy(i).allowed).toBe(false)
  })
  it.each(["payload", "command", "policy", "authority"])("stale approval %s is rejected", (change) => {
    const i = input(); approve(i)
    if (change === "payload") i.command.payloadHash = "b".repeat(64)
    if (change === "command") i.command.id = ACTOR
    if (change === "policy") i.policy.version++
    if (change === "authority") i.facts.approval!.currentAuthorityVerified = false
    expect(evaluatePolicy(i).allowed).toBe(false)
  })
  it("direct human action needs no second approval but still observes Off", () => {
    const i = input(); i.command.source = "human"
    expect(evaluatePolicy(i).allowed).toBe(true)
    i.policy.connectorCeiling = "off"
    expect(evaluatePolicy(i).allowed).toBe(false)
  })
  it("manager authority must be explicit and never includes owner-only actions", () => {
    const i = input(); i.actor.role = "manager"; approve(i)
    expect(evaluatePolicy(i).allowed).toBe(true)
    i.actor.authorizedOperations = []
    expect(evaluatePolicy(i).allowed).toBe(false)
    const merge = input("customer.merge"); merge.actor.role = "manager"; approve(merge)
    expect(evaluatePolicy(merge).reasons).toContain("owner_required")
  })
  it("staff cannot obtain write/approval authority from a supplied action grant", () => {
    for (const op of ["sms.reply", "customer.merge", "assignment.change", "memory.publish.customer"] as const) {
      const i = input(op); i.actor.role = "staff"; i.policy.actionGrant = "autonomous"; approve(i)
      expect(evaluatePolicy(i).reasons).toContain("staff_operation_forbidden")
    }
  })
  it("manager discount defaults to zero and checks exact bound", () => {
    const i = input("quote.discount"); i.actor.role = "manager"; i.command.source = "human"; i.facts.discountAmount = 1
    expect(evaluatePolicy(i).allowed).toBe(false)
    i.actor.discountLimit = 1
    expect(evaluatePolicy(i).allowed).toBe(true)
    i.facts.discountAmount = null
    expect(evaluatePolicy(i).allowed).toBe(false)
  })
  it.each(["booking.create", "booking.reschedule", "booking.cancel", "quote.send", "quote.discount"] as const)("%s retains its existing hard floor", (op) => {
    const i = input(op); i.policy.actionGrant = "autonomous"
    expect(evaluatePolicy(i).mode).toBe("approval")
    expect(evaluatePolicy(i).allowed).toBe(false)
  })
  it("reads/drafts never become domain executions even with autonomy", () => {
    for (const op of ["crm.read", "draft.private", "memory.propose"] as const) {
      const i = input(op); i.policy.actionGrant = "autonomous"
      expect(evaluatePolicy(i).allowed).toBe(false)
    }
  })
  it("mechanical updates require verified causation", () => {
    const i = input("pipeline.mechanical"); i.facts.causalActionVerified = false
    expect(evaluatePolicy(i).allowed).toBe(false)
  })
  it("verified connector setup is required for intake and notifications", () => {
    for (const op of ["intake.capture", "identity.deduplicate", "manager.notify", "voice.inbound"] as const) {
      const i = input(op); i.policy.actionGrant = "autonomous"; i.facts.setupVerified = false
      expect(evaluatePolicy(i).allowed).toBe(false)
    }
  })
  it("one action's opt-in cannot grant another operation", () => {
    const nurture = input("sms.nurture"); nurture.policy.actionGrant = "autonomous"
    expect(evaluatePolicy(nurture).allowed).toBe(true)
    expect(evaluatePolicy(input("booking.create")).allowed).toBe(false)
    expect(evaluatePolicy(input("sms.confirm")).allowed).toBe(false)
    nurture.command.operation = "sms.confirm"
    expect(evaluatePolicy(nurture).reasons).toContain("action_policy_mismatch")
  })
  it("a mismatched connector fails closed", () => {
    const i = input(); i.command.connector = "email"
    expect(evaluatePolicy(i).allowed).toBe(false)
  })
  it("legacy translation never reinterprets suggest as a private draft or grants autonomy", () => {
    expect(translateLegacyMode("suggest")).toBe("approval")
    expect(translateLegacyMode("autonomous")).toBe("approval")
    for (const value of ["custom", undefined, null, "bogus"]) expect(translateLegacyMode(value)).toBe("off")
  })
})

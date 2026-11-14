import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

import { ACTIVATION_BLOCKERS, isActivationBlocker } from "@/lib/agent-os/definition-dto"
import { agentDefinitionDraftSchema } from "@/lib/agent-os/definition-schema"
import { ALL_BLOCKER_CODES, BLOCKER_COPY, describeBlocker, describeBlockers } from "@/lib/agent-os/builder/blocker-copy"
import {
  createRequestIdTracker,
  deriveDefinitionKey,
  fromDefinition,
  isDirty,
  saveFingerprint,
  seedForm,
  toDefinitionInput,
  type FormState,
} from "@/lib/agent-os/builder/form"
import {
  CONNECTOR_LABELS,
  LIFECYCLE_LABELS,
  MODE_HELP,
  MODE_LABELS,
  OPERATION_LABELS,
  PIN_STATUS_LABELS,
  POST_MVP_OPERATIONS,
  defaultMaximumMode,
  describeSchedule,
  describeToolReason,
  maximumModeChoices,
} from "@/lib/agent-os/builder/labels"
import { interpretActivation, interpretLifecycle, interpretSave } from "@/lib/agent-os/builder/results"
import { STEP_META, STEP_ORDER, nextStep, parseRevisionParam, parseStepParam, parseUuidParam, previousStep } from "@/lib/agent-os/builder/steps"
import { pageStateFor } from "@/lib/agent-os/builder/states"
import { ACTIONS, modes, type Operation } from "@/lib/control-center/policy"

const agentId = "00000000-0000-4000-8000-000000000004"

function filled(): FormState {
  const form = seedForm(deriveDefinitionKey("Quote follow-up", agentId))
  form.job = { roleLabel: "Quote follow-up", goal: "Follow up with quiet quotes and draft a message.", expectedOutcomes: ["Every quiet quote gets a draft"], stopConditions: ["Customer asks to stop"] }
  return form
}

describe("blocker copy source lock", () => {
  it("has reviewed copy for EVERY backend blocker code and nothing else", () => {
    expect(Object.keys(BLOCKER_COPY).sort()).toEqual([...ACTIVATION_BLOCKERS].sort())
    expect([...ALL_BLOCKER_CODES].sort()).toEqual([...ACTIVATION_BLOCKERS].sort())
  })

  it("every entry is plain language: a title, a sentence, and no provider, url, secret or raw code", () => {
    for (const [code, copy] of Object.entries(BLOCKER_COPY)) {
      expect(copy.title.length, code).toBeGreaterThan(5)
      expect(copy.detail.length, code).toBeGreaterThan(20)
      const text = `${copy.title} ${copy.detail} ${copy.action?.label ?? ""}`
      expect(text, code).not.toMatch(/stripe|supabase|twilio|vapi|openai|anthropic|https?:\/\/|sk_|whsec|[a-z]+_[a-z]+_[a-z]+/i)
      if (copy.action?.href) expect(copy.action.href.startsWith("/"), code).toBe(true)
    }
  })

  it("an unknown or malformed code fails closed as 'could not be confirmed', never as success or nothing", () => {
    for (const bad of ["brand_new_backend_code", "", null, undefined, 42, {}, "eligible", "ok"]) {
      const { code, copy } = describeBlocker(bad)
      expect(code).toBe("evidence_unavailable")
      expect(copy.title).toMatch(/could not be confirmed/i)
    }
    expect(describeBlockers(["definitely_new", "also_new"]).map((e) => e.code)).toEqual(["evidence_unavailable"])
    expect(describeBlockers([]).length).toBe(0)
  })

  it("keeps the vocabulary guard and the copy in lock step", () => {
    for (const code of ACTIVATION_BLOCKERS) expect(isActivationBlocker(code)).toBe(true)
    expect(isActivationBlocker("new_code")).toBe(false)
  })

  it("the evaluation blocker tells the owner how to clear it", () => {
    expect(BLOCKER_COPY.evaluation_required.detail).toMatch(/Run the checks from the Test step/)
  })
})

describe("labels cover the whole Control Center catalog and every state", () => {
  const operations = Object.keys(ACTIONS) as Operation[]

  it("labels every operation, mode, connector, lifecycle and memory status", () => {
    expect(Object.keys(OPERATION_LABELS).sort()).toEqual([...operations].sort())
    for (const op of operations) expect(OPERATION_LABELS[op].label.length).toBeGreaterThan(3)
    expect(Object.keys(MODE_LABELS).sort()).toEqual([...modes].sort())
    expect(Object.keys(MODE_HELP).sort()).toEqual([...modes].sort())
    expect(Object.keys(LIFECYCLE_LABELS).sort()).toEqual(["active", "blocked", "draft", "legacy_unversioned", "paused"])
    expect(Object.keys(PIN_STATUS_LABELS).sort()).toEqual(["changed", "current", "expired", "revoked", "stale"])
    for (const op of operations) expect(CONNECTOR_LABELS[ACTIONS[op].connector]).toBeTruthy()
  })

  it("never shows a raw operation id as the owner-facing label", () => {
    for (const op of operations) expect(OPERATION_LABELS[op].label).not.toBe(op)
  })

  it("read and suggest tools can never be requested above their ceiling; defaults are valid for the schema", () => {
    expect(maximumModeChoices("crm.read")).toEqual(["off", "read"])
    expect(maximumModeChoices("draft.private")).toEqual(["off", "read", "suggest"])
    expect(maximumModeChoices("sms.reply")).toEqual([...modes])
    for (const op of operations) {
      expect(maximumModeChoices(op)).toContain(defaultMaximumMode(op))
      const form = filled()
      form.tools = [{ operation: op, maximumMode: defaultMaximumMode(op) }]
      expect(toDefinitionInput(form).ok, op).toBe(true)
    }
  })

  it("keeps post-MVP tools visibly unavailable", () => {
    expect([...POST_MVP_OPERATIONS].sort()).toEqual(["campaign.send", "voice.outbound"])
  })

  it("describes tool reasons, ceilings and unknown reasons without hiding them", () => {
    expect(describeToolReason("channel_not_ready")).toMatch(/connection/i)
    expect(describeToolReason("sms_ceiling")).toMatch(/ceiling/i)
    expect(describeToolReason("something_new")).toMatch(/rule applies/i)
  })

  it("describes every schedule shape", () => {
    expect(describeSchedule({ kind: "manual" })).toMatch(/manual/i)
    expect(describeSchedule({ kind: "event", event: "lead.received" })).toMatch(/new lead/i)
    expect(describeSchedule({ kind: "interval", everyMinutes: 15 })).toBe("Every 15 minutes.")
    expect(describeSchedule({ kind: "interval", everyMinutes: 120 })).toBe("Every 2 hours.")
    expect(describeSchedule({ kind: "interval", everyMinutes: 1440 })).toBe("Every day.")
    expect(describeSchedule({ kind: "interval", everyMinutes: 10080 })).toBe("Every 7 days.")
  })
})

describe("steps and route params", () => {
  it("has the seven steps in order", () => {
    expect(STEP_ORDER).toEqual(["job", "knowledge", "tools", "limits", "schedule", "test", "activate"])
    expect(Object.keys(STEP_META).sort()).toEqual([...STEP_ORDER].sort())
    expect(nextStep("job")).toBe("knowledge")
    expect(nextStep("activate")).toBeNull()
    expect(previousStep("job")).toBeNull()
    expect(previousStep("activate")).toBe("test")
  })

  it("validates ?step= and falls back to the first step", () => {
    expect(parseStepParam("tools")).toBe("tools")
    expect(parseStepParam(["limits", "job"])).toBe("limits")
    for (const bad of [undefined, "", "TOOLS", "../etc", "constructor", "__proto__", ["nope"]]) expect(parseStepParam(bad)).toBe("job")
  })

  it("accepts only well-formed UUIDs and positive revision integers", () => {
    expect(parseUuidParam(agentId)).toBe(agentId)
    expect(parseUuidParam(agentId.toUpperCase())).toBe(agentId)
    for (const bad of [undefined, "", "abc", `${agentId}x`, `../${agentId}`, "00000000-0000-4000-8000-00000000000", [], ["bad"]]) expect(parseUuidParam(bad as never)).toBeNull()
    expect(parseRevisionParam("1")).toBe(1)
    expect(parseRevisionParam("123456789")).toBe(123456789)
    for (const bad of ["0", "-1", "01", "1.5", "1e3", "", " 1", "abc", "1234567890", undefined, "0x10"]) expect(parseRevisionParam(bad as never)).toBeNull()
  })

  it("maps read results to intentional page states, never to an empty or eligible view", () => {
    expect(pageStateFor({ status: "ok", data: 1 })).toBeNull()
    expect(pageStateFor({ status: "forbidden" })).toBe("forbidden")
    expect(pageStateFor({ status: "unavailable", reason: "agent_not_found" })).toBe("not_found")
    expect(pageStateFor({ status: "unavailable", reason: "revision_not_found" })).toBe("not_found")
    expect(pageStateFor({ status: "unavailable", reason: "invalid_request" })).toBe("invalid")
    expect(pageStateFor({ status: "unavailable", reason: "anything_else" })).toBe("unavailable")
  })
})

describe("schema-bound form conversion", () => {
  it("a fresh seed is conservative but REQUIRES owner job input before it can be saved", () => {
    const seed = seedForm("agent-aaaaaa")
    expect(seed.knowledge.sourceIds).toEqual([])
    expect(seed.tools).toEqual([])
    expect(seed.schedule).toEqual({ kind: "manual" })
    expect(seed.routing.strategy).toBe("cost_aware")
    const result = toDefinitionInput(seed)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(Object.keys(result.errors).some((p) => p.startsWith("job."))).toBe(true)
  })

  it("converts a complete form to the exact strict definition body (concurrency pinned to 1)", () => {
    const result = toDefinitionInput(filled())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.definition.limits.maximumConcurrentRuns).toBe(1)
    expect(result.definition).not.toHaveProperty("revision")
    expect(result.definition).not.toHaveProperty("lifecycle")
    expect(agentDefinitionDraftSchema.safeParse({ ...result.definition, revision: 1, lifecycle: "draft" }).success).toBe(true)
  })

  it("derives a schema-valid stable key for any name", () => {
    for (const name of ["Quote follow-up", "  ", "123 numbers", "Ünïcode ñame!!", "x".repeat(300), "---", "Reminder 🚗"]) {
      const key = deriveDefinitionKey(name, agentId)
      expect(key, name).toMatch(/^[a-z][a-z0-9-]{2,63}$/)
    }
    expect(deriveDefinitionKey("Quote follow-up", agentId)).toBe(deriveDefinitionKey("Quote follow-up", agentId))
  })

  it("round-trips a saved definition without drift", () => {
    const result = toDefinitionInput(filled())
    if (!result.ok) throw new Error("fixture invalid")
    const back = toDefinitionInput(fromDefinition({ ...result.definition, revision: 3, lifecycle: "draft" }))
    expect(back).toEqual(result)
  })

  it("reports a field error for every schema bound, with the allowed range in the message", () => {
    const cases: [string, (f: FormState) => void, string][] = [
      ["job.roleLabel", (f) => (f.job.roleLabel = "x"), "2"],
      ["job.goal", (f) => (f.job.goal = "short"), "8"],
      ["job.expectedOutcomes", (f) => (f.job.expectedOutcomes = [""]), "1–8"],
      ["job.stopConditions", (f) => (f.job.stopConditions = ["", " "]), "1–12"],
      ["job.expectedOutcomes.0", (f) => (f.job.expectedOutcomes = ["ab"]), "3"],
      ["knowledge.maxResultsPerQuery", (f) => (f.knowledge.maxResultsPerQuery = "21"), "1–20"],
      ["limits.maximumStepsPerRun", (f) => (f.limits.maximumStepsPerRun = "31"), "1–30"],
      ["limits.maximumRuntimeSeconds", (f) => (f.limits.maximumRuntimeSeconds = "4"), "5–900"],
      ["limits.maximumCreditsPerRun", (f) => (f.limits.maximumCreditsPerRun = "100001"), "100,000"],
      ["limits.maximumRunsPerDay", (f) => (f.limits.maximumRunsPerDay = "0"), "1–1,440"],
      ["limits.maximumStepsPerRun", (f) => (f.limits.maximumStepsPerRun = "1.5"), "1–30"],
      ["limits.maximumStepsPerRun", (f) => (f.limits.maximumStepsPerRun = "abc"), "1–30"],
      ["schedule.everyMinutes", (f) => (f.schedule = { kind: "interval", everyMinutes: "14" }), "15"],
      ["schedule.everyMinutes", (f) => (f.schedule = { kind: "interval", everyMinutes: "10081" }), "10,080"],
    ]
    for (const [path, mutate, hint] of cases) {
      const form = filled()
      mutate(form)
      const result = toDefinitionInput(form)
      expect(result.ok, path).toBe(false)
      if (result.ok) continue
      expect(result.errors[path], path).toBeTruthy()
      expect(result.errors[path], path).toContain(hint)
    }
  })

  it("accepts every exact boundary value", () => {
    const form = filled()
    form.limits = { maximumStepsPerRun: "30", maximumRuntimeSeconds: "900", maximumCreditsPerRun: "100000", maximumRunsPerDay: "1440" }
    form.knowledge.maxResultsPerQuery = "20"
    form.schedule = { kind: "interval", everyMinutes: "10080" }
    expect(toDefinitionInput(form).ok).toBe(true)
    form.limits = { maximumStepsPerRun: "1", maximumRuntimeSeconds: "5", maximumCreditsPerRun: "0", maximumRunsPerDay: "1" }
    form.knowledge.maxResultsPerQuery = "1"
    form.schedule = { kind: "interval", everyMinutes: "15" }
    expect(toDefinitionInput(form).ok).toBe(true)
  })

  it("refuses a read/suggest tool requested above its ceiling and a duplicate tool", () => {
    const above = filled()
    above.tools = [{ operation: "crm.read", maximumMode: "approval" }]
    expect(toDefinitionInput(above).ok).toBe(false)
    const dup = filled()
    dup.tools = [{ operation: "sms.reply", maximumMode: "approval" }, { operation: "sms.reply", maximumMode: "suggest" }]
    expect(toDefinitionInput(dup).ok).toBe(false)
  })

  it("tracks unsaved changes only when content actually differs", () => {
    const base = filled()
    expect(isDirty(base, filled())).toBe(false)
    const edited = filled()
    edited.job.goal = "A different goal for the agent."
    expect(isDirty(edited, base)).toBe(true)
    const spaced = filled()
    spaced.job.roleLabel = "  Quote follow-up  "
    expect(isDirty(spaced, base)).toBe(false)
  })
})

describe("save request ids", () => {
  let n = 0
  const make = () => createRequestIdTracker(() => `req-${++n}`)
  const body = (goal: string) => {
    const form = filled()
    form.job.goal = goal
    const result = toDefinitionInput(form)
    if (!result.ok) throw new Error("fixture")
    return result.definition
  }

  it("reuses the id for an UNCHANGED retry", () => {
    const t = make()
    const a = t.idFor(saveFingerprint(agentId, 1, body("Follow up with quiet quotes today.")))
    const b = t.idFor(saveFingerprint(agentId, 1, body("Follow up with quiet quotes today.")))
    expect(b).toBe(a)
  })

  it("issues a NEW id when any field changes after a failure, so a changed replay never conflicts", () => {
    const t = make()
    const first = t.idFor(saveFingerprint(agentId, 1, body("Follow up with quiet quotes today.")))
    const changed = t.idFor(saveFingerprint(agentId, 1, body("Follow up with quiet quotes tomorrow.")))
    expect(changed).not.toBe(first)
  })

  it("issues a new id when the parent revision changes, and after a settled success", () => {
    const t = make()
    const content = body("Follow up with quiet quotes today.")
    const first = t.idFor(saveFingerprint(agentId, 1, content))
    expect(t.idFor(saveFingerprint(agentId, 2, content))).not.toBe(first)
    const second = t.idFor(saveFingerprint(agentId, 2, content))
    t.settle()
    expect(t.idFor(saveFingerprint(agentId, 2, content))).not.toBe(second)
  })

  it("uses real UUIDs in the browser", () => {
    const t = createRequestIdTracker(() => crypto.randomUUID())
    expect(t.idFor("x")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})

describe("command result interpretation never turns a failure into success", () => {
  it("save: created vs replayed are reported truthfully; conflicts and errors are distinct", () => {
    expect(interpretSave({ ok: true, outcome: "created", revision: 4, definitionHash: "a".repeat(64), parentRevision: 3 })).toMatchObject({ kind: "saved", outcome: "created", revision: 4 })
    expect(interpretSave({ ok: true, outcome: "replayed", revision: 4, definitionHash: "a".repeat(64), parentRevision: 3 })).toMatchObject({ kind: "saved", outcome: "replayed" })
    expect(interpretSave({ ok: false, code: "conflict" })).toEqual({ kind: "conflict" })
    expect(interpretSave({ ok: false, code: "parent_not_found" })).toEqual({ kind: "conflict" })
    for (const code of ["forbidden", "agent_not_found", "legacy_agent_enabled", "memory_not_selectable", "invalid_definition"] as const) {
      const r = interpretSave({ ok: false, code })
      expect(r.kind).toBe("error")
      if (r.kind === "error") expect(r.retryable).toBe(false)
    }
    const transient = interpretSave({ ok: false, code: "unavailable" })
    expect(transient).toMatchObject({ kind: "error", retryable: true })
  })

  it("activation: only ok:true is activated; a Checkout URL is surfaced only if it is the server's https Stripe URL", () => {
    expect(interpretActivation({ ok: true, outcome: "activated", revision: 2 })).toEqual({ kind: "activated", revision: 2, alreadyActive: false })
    expect(interpretActivation({ ok: true, outcome: "already_active", revision: 2 })).toMatchObject({ alreadyActive: true })
    expect(interpretActivation({ ok: false, code: "forbidden", reasons: [], billing: null })).toEqual({ kind: "forbidden" })
    const blocked = interpretActivation({ ok: false, code: "evaluation_required", reasons: ["evaluation_required"], billing: null })
    expect(blocked).toMatchObject({ kind: "blocked", reasons: ["evaluation_required"], checkoutUrl: null })
    const billing = (url: string | null) => ({ state: "pending", eligibleToActivate: false, blockingReason: "checkout_required", checkoutUrl: url }) as never
    const ok = interpretActivation({ ok: false, code: "billing_not_active", reasons: ["billing_not_active"], billing: billing("https://checkout.stripe.com/c/pay/cs_test_1") })
    expect(ok).toMatchObject({ kind: "blocked", checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_1" })
    for (const url of ["http://checkout.stripe.com/x", "https://evil.example/x", "javascript:alert(1)", "https://checkout.stripe.com.evil.example/x", null]) {
      expect(interpretActivation({ ok: false, code: "billing_not_active", reasons: ["billing_not_active"], billing: billing(url) })).toMatchObject({ checkoutUrl: null })
    }
    // An empty reason list still blocks, using the code.
    expect(interpretActivation({ ok: false, code: "evidence_unavailable", reasons: [], billing: null })).toMatchObject({ kind: "blocked", reasons: ["evidence_unavailable"] })
  })

  it("lifecycle: stale pointers and refusals are distinguished", () => {
    expect(interpretLifecycle({ ok: true, outcome: "changed" })).toEqual({ kind: "changed" })
    expect(interpretLifecycle({ ok: true, outcome: "unchanged" })).toEqual({ kind: "unchanged" })
    expect(interpretLifecycle({ ok: false, code: "pointer_changed" })).toEqual({ kind: "stale" })
    for (const code of ["forbidden", "unavailable", "invalid", "agent_not_found", "no_active_definition", "invalid_transition"] as const) {
      expect(interpretLifecycle({ ok: false, code }).kind).toBe("error")
    }
  })
})

describe("builder sources keep the contract", () => {
  const builder = readFileSync("src/components/agents/definition-builder.tsx", "utf8")
  const parts = readFileSync("src/components/agents/builder-steps.tsx", "utf8")

  it("activation is reachable only from the confirmation handler, never from render or an effect", () => {
    const calls = builder.match(/activateAgentDefinitionRevision\(/g) ?? []
    expect(calls.length).toBe(1)
    const idx = builder.indexOf("activateAgentDefinitionRevision({")
    const before = builder.slice(0, idx)
    expect(before.slice(before.lastIndexOf("function confirmActivation"))).toContain("function confirmActivation")
    expect(builder).toMatch(/onConfirm=\{confirmActivation\}/)
    // Only the three exact-revision fields are echoed.
    const call = builder.slice(idx, idx + 300)
    expect(call).toContain("expectedHash: sources.definitionHash")
    expect(call).toContain("expectedPointer: sources.expectedPointer")
    expect(call).not.toMatch(/policy|knowledge|connector|billing|evaluation/i)
  })

  it("the Test step only REQUESTS the trusted evaluator: ids out, no result ever authored in the browser", () => {
    const test = parts.slice(parts.indexOf("export function TestStep"))
    expect(test).not.toMatch(/use server|saveAgentDefinitionRevision|activateAgentDefinition|recordTrusted|record_evaluation|fetch\(|useEffect/)
    expect(test).toContain("runAgentRevisionEvaluation({ agentId, revision: savedRevision })")
    expect(test).not.toMatch(/passRate:|safetyPassed:|fixtureHash|suiteVersion:|evaluationKey/)
    expect(test).toContain("never calls a model")
    expect(test).toContain("not an answer-quality score")
  })

  it("never reads or stores builder truth in browser storage", () => {
    for (const source of [builder, parts]) expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB/)
  })
})

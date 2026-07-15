import { readFileSync } from "node:fs"
import { describe, it, expect } from "vitest"

/**
 * P0 honest-failure locks (fix-pass 2026-07-13). Production verbatim: the
 * agent told the owner "memory search isn't pulling anyone up… might be a
 * connection issue" when the query simply had no hits. These locks make the
 * fabricated-excuse class unrepresentable in OUR copy and pin the contracts
 * that keep the model honest:
 *   - no agent-facing module ships an invented infrastructure excuse,
 *   - an empty search result explicitly says it's a normal miss,
 *   - a real tool error says it failed on our side, nothing more,
 *   - both agent system prompts carry the honesty + find_person-first rules.
 */

const AGENT_MODULES = [
  "../src/lib/owner-agent.ts",
  "../src/lib/bi-agent.ts",
  "../src/lib/bi-tools.ts",
  "../src/lib/agent-runtime.ts",
  "../src/lib/agent-planner.ts",
  "../src/lib/find-person.ts",
] as const

/** Fabricated-cause phrases that must never appear in shipped copy.
 *  (Negated usages like "NOT a connection problem" are the fix itself —
 *  we scan for the affirmative excuse forms.) */
const BANNED = [
  "might be a connection",
  "connection issue",
  "network issue",
  "network problem",
  "connectivity problem",
  "try again later",
  "servers are busy",
]

function sourceOf(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8")
}

describe("no invented infrastructure excuses in agent copy", () => {
  for (const mod of AGENT_MODULES) {
    it(`${mod.split("/").pop()} is clean`, () => {
      const src = sourceOf(mod).toLowerCase()
      for (const phrase of BANNED) {
        expect(src, `banned excuse "${phrase}" found in ${mod}`).not.toContain(
          phrase
        )
      }
    })
  }
})

describe("the search_memory result contract", () => {
  const src = sourceOf("../src/lib/bi-tools.ts")

  it("an empty result explains it's a miss, not a malfunction", () => {
    expect(src).toContain("NOT a system or connection problem")
    expect(src).toContain("use find_person")
  })

  it("a real error says it failed on our side and forbids speculation", () => {
    expect(src).toContain("failed on our side")
    expect(src).toContain("Do not speculate about causes")
    // The internals-leaking string is gone.
    expect(src).not.toContain("no embeddings?")
  })
})

describe("system prompts carry the honesty rules", () => {
  it("owner-agent: find_person first + honest-miss rule", () => {
    const src = sourceOf("../src/lib/owner-agent.ts")
    expect(src).toContain("use find_person FIRST")
    expect(src).toContain("NEVER blame a connection, network, or system problem")
    expect(src).toContain("say the lookup failed on our side")
  })

  it("bi-agent system prompt: honest results block present", () => {
    const src = sourceOf("../src/lib/bi-agent.ts")
    expect(src).toContain("Honest results, always")
    expect(src).toContain("An empty result is a MISS")
  })
})

describe("find_person is the primary person path (tool surface)", () => {
  it("the tool exists and search_memory demotes itself for existence checks", () => {
    const src = sourceOf("../src/lib/bi-tools.ts")
    expect(src).toContain('name: "find_person"')
    expect(src).toContain("ALWAYS the first stop to find a specific person")
    expect(src).toContain(
      "an empty result here never means the person is missing from the CRM"
    )
  })
})

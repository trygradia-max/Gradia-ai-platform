import { describe, it, expect } from "vitest"

import {
  classifyGroup,
  mergeWithinSet,
  resolveImportSet,
  type ExistingCustomer,
  type ImportCandidate,
} from "@/lib/recovery/dedupe"

/**
 * Deterministic dedupe (GRADIA_CUSTOMER_RECOVERY_SPEC §2.2) — matching is code,
 * never the LLM. These lock the merge/new/ambiguous outcomes and the within-set
 * collapse, and prove "ambiguous" stays conservative (owner takes a look).
 */

const cand = (
  name: string | null,
  phones: string[],
  emails: string[],
  provenance = "p"
): ImportCandidate<string> => ({ name, phones, emails, provenance })

describe("recovery dedupe — within-set collapse", () => {
  it("collapses a thread + contact card for the same person (shared email)", () => {
    const groups = mergeWithinSet([
      cand("Mike Sandoval", ["(650) 555-0133"], ["mike@gmail.com"], "thread"),
      cand("Mike S.", [], ["mike@gmail.com"], "vcard"),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].members.sort()).toEqual(["thread", "vcard"])
  })

  it("collapses across a shared phone written two different ways", () => {
    const groups = mergeWithinSet([
      cand("Greg", ["415.555.0177"], [], "a"),
      cand("Greg O", ["+1 (415) 555-0177"], [], "b"),
    ])
    expect(groups).toHaveLength(1)
  })

  it("keeps genuinely different people apart", () => {
    const groups = mergeWithinSet([
      cand("A", ["415-555-0001"], ["a@x.com"], "a"),
      cand("B", ["415-555-0002"], ["b@x.com"], "b"),
    ])
    expect(groups).toHaveLength(2)
  })

  it("flags a within-set name clash on the same number", () => {
    const groups = mergeWithinSet([
      cand("Greg Olsen", ["415-555-0177"], [], "a"),
      cand("Dana Reyes", ["415-555-0177"], [], "b"),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].nameConflict).toBe(true)
  })
})

describe("recovery dedupe — match against existing CRM", () => {
  const existing: ExistingCustomer[] = [
    { id: "c1", name: "Marcus Webb", phone: "+14155550142", email: "marcus@gmail.com" },
    { id: "c2", name: "Dana Reyes", phone: null, email: "dana.reyes@outlook.com" },
  ]

  it("merges into an existing customer by phone (different formatting)", () => {
    const d = classifyGroup(
      mergeWithinSet([cand("Marcus Webb", ["(415) 555-0142"], [])])[0],
      existing
    )
    expect(d).toEqual({ kind: "merge_into", customerId: "c1" })
  })

  it("merges into an existing customer by email", () => {
    const d = classifyGroup(
      mergeWithinSet([cand("Dana", [], ["dana.reyes@outlook.com"])])[0],
      existing
    )
    expect(d).toEqual({ kind: "merge_into", customerId: "c2" })
  })

  it("creates a new customer when nothing matches", () => {
    const d = classifyGroup(
      mergeWithinSet([cand("Priya Shah", [], ["priya@gmail.com"])])[0],
      existing
    )
    expect(d).toEqual({ kind: "new" })
  })

  it("flags ambiguous when a phone matches but the name conflicts", () => {
    const d = classifyGroup(
      mergeWithinSet([cand("Someone Else", ["415-555-0142"], [])])[0],
      existing
    )
    expect(d.kind).toBe("ambiguous")
  })

  it("still merges on an email match even when the display name differs", () => {
    // Email is a strong identity signal — a nickname shouldn't block it.
    const d = classifyGroup(
      mergeWithinSet([cand("M. Webb", [], ["marcus@gmail.com"])])[0],
      existing
    )
    expect(d).toEqual({ kind: "merge_into", customerId: "c1" })
  })

  it("flags ambiguous when a group matches more than one existing customer", () => {
    const d = classifyGroup(
      mergeWithinSet([
        cand("Mixed", ["415-555-0142"], ["dana.reyes@outlook.com"]),
      ])[0],
      existing
    )
    expect(d.kind).toBe("ambiguous")
  })
})

describe("recovery dedupe — end to end", () => {
  it("resolves a mixed import set", () => {
    const existing: ExistingCustomer[] = [
      { id: "c1", name: "Marcus Webb", phone: "+14155550142", email: null },
    ]
    const resolved = resolveImportSet(
      [
        cand("Marcus Webb", ["(415) 555-0142"], [], "merge"),
        cand("Priya Shah", [], ["priya@gmail.com"], "new"),
      ],
      existing
    )
    const kinds = resolved.map((r) => r.decision.kind).sort()
    expect(kinds).toEqual(["merge_into", "new"])
  })
})

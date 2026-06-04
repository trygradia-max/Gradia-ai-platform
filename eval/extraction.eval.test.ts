import { describe, it } from "vitest"

import { extractLeadFromRawText } from "@/lib/ai-service"
import { LIVE, assertField, type FieldSpec } from "./_lib"
import cases from "./cases/extraction.json"

type ExtractionCase = {
  name: string
  input: string
  expect: Record<string, FieldSpec>
}

/**
 * Tier 2 — golden set for the Haiku lead extractor (ai-service.ts).
 * Exact/structural assertions, including the empty-string contract (the model
 * must emit "" rather than a confident guess when a field has no support).
 */
describe.skipIf(!LIVE)("extraction golden [live]", () => {
  it.each(cases as ExtractionCase[])("$name", async (c) => {
    const out = await extractLeadFromRawText(c.input)
    for (const [field, spec] of Object.entries(c.expect)) {
      assertField(out[field as keyof typeof out], spec, `${c.name} → ${field}`)
    }
  })
})

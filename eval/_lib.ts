import { ChatAnthropic } from "@langchain/anthropic"
import { z } from "zod"
import { expect } from "vitest"

/**
 * Live tests (Tier 2 golden + Tier 3 judge) hit real LLM APIs — they cost
 * tokens and are nondeterministic, so they only run when explicitly asked for
 * with EVAL_LIVE=1 and a key present. Tier 1 (guardrails) is always on.
 */
export const LIVE =
  process.env.EVAL_LIVE === "1" && Boolean(process.env.ANTHROPIC_API_KEY)

// ---------------------------------------------------------------------------
// Tolerant field matchers for golden cases.
//
// LLM output formatting varies (phone spacing, "Model 3" vs "Model-3"), so we
// assert on substance, not exact strings — EXCEPT the empty-string contract,
// which is strict: the right answer to "no signal" is exactly "".
// ---------------------------------------------------------------------------
export type FieldSpec =
  | { empty: true }
  | { contains: string }
  | { matches: string }
  | { digits: string }

export function assertField(value: string, spec: FieldSpec, label: string) {
  if ("empty" in spec) {
    expect(value, `${label} — expected empty (no confident guess)`).toBe("")
  } else if ("contains" in spec) {
    expect(
      value.toLowerCase(),
      `${label} — expected to contain "${spec.contains}"`
    ).toContain(spec.contains.toLowerCase())
  } else if ("matches" in spec) {
    expect(value, `${label} — expected to match /${spec.matches}/i`).toMatch(
      new RegExp(spec.matches, "i")
    )
  } else if ("digits" in spec) {
    expect(
      value.replace(/\D/g, ""),
      `${label} — expected digits to include ${spec.digits}`
    ).toContain(spec.digits)
  }
}

// ---------------------------------------------------------------------------
// LLM-as-judge — a second model scores open-ended output against a rubric.
// Use sparingly (it costs tokens and adds nondeterminism); reserve for things
// with no single right string, like answer quality and message tone.
// ---------------------------------------------------------------------------
const judgeSchema = z.object({
  pass: z.boolean().describe("true only if EVERY must-have in the rubric holds"),
  score: z.number().min(0).max(5).describe("0 = fails rubric, 5 = exemplary"),
  reason: z.string().describe("one terse sentence citing the deciding factor"),
})

export type Verdict = z.infer<typeof judgeSchema>

export async function judge(args: {
  output: string
  rubric: string
}): Promise<Verdict> {
  const llm = new ChatAnthropic({
    model: "claude-sonnet-4-6",
    temperature: 0,
    maxTokens: 256,
    apiKey: process.env.ANTHROPIC_API_KEY,
  }).withStructuredOutput(judgeSchema, { name: "score" })

  return (await llm.invoke([
    [
      "system",
      "You are a strict evaluator. Score the OUTPUT against the RUBRIC. " +
        "pass=true only if every must-have holds. Be terse and literal.",
    ],
    ["human", `RUBRIC:\n${args.rubric}\n\nOUTPUT:\n${args.output}`],
  ])) as Verdict
}

// ---------------------------------------------------------------------------
// Minimal in-memory Supabase double for the BI agent.
//
// Every query-builder method returns the same proxy; awaiting it resolves to
// `result`. Lets us drive bi-tools (count_leads etc.) with a known dataset and
// no real database — so we can assert answer correctness + read-only tool use.
// ---------------------------------------------------------------------------
export function mockSupabase(result: {
  count?: number
  data?: unknown[]
  error: null | { message: string }
}) {
  const proxy: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") {
          return (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
            Promise.resolve(result).then(res, rej)
        }
        return () => proxy
      },
    }
  )
  return proxy
}

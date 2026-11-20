import type { CallExtractor, ExtractorResult } from "@/lib/call-copilot/extractor"
import type { Citation, ExtractorInput } from "@/lib/call-copilot/extraction-schema"

/**
 * Fixtures for Call Copilot extraction tests. Everything here is fictional: reserved example names,
 * the 555-01xx range and `example.test` addresses. No live model or provider is involved; the fixture
 * extractor returns exactly what a test scripts, which is the point of the seam.
 */

export type FixtureSegment = { index: number; speaker: "operator" | "caller" | "unknown"; text: string }

export const SEGMENTS: FixtureSegment[] = [
  { index: 0, speaker: "operator", text: "Thanks for calling Fictional Shine, this is Sam. How can I help?" },
  { index: 1, speaker: "caller", text: "Hi, this is Jordan Rivera. My number is plus one five five five zero one four two nine eight eight and my email is jordan dot rivera at example dot test." },
  { index: 2, speaker: "caller", text: "I have a 2021 Tesla Model 3, black. I'd like a ceramic coating and a full interior detail." },
  { index: 3, speaker: "caller", text: "The paint has some light swirl marks and there is a rock chip on the hood. It would have to be at my home in Fictionville." },
  { index: 4, speaker: "caller", text: "Mornings work best, I can't do Tuesdays, and I'd like a text, not a call, when you have a time." },
  { index: 5, speaker: "operator", text: "Great. I will book Friday December 4th at 9 am for 180 minutes and send you a quote." },
  { index: 6, speaker: "caller", text: "Also, please remember I always prefer drop-off after nine in the morning." },
  { index: 7, speaker: "operator", text: "I'll follow up with you on Monday about the quote." },
]

/** Code-point citation of the first occurrence of `needle` in a fixture segment. */
export function cite(segments: FixtureSegment[], segmentIndex: number, needle: string): Citation {
  const seg = segments.find((s) => s.index === segmentIndex)
  if (!seg) throw new Error(`no fixture segment ${segmentIndex}`)
  const at = seg.text.toLowerCase().indexOf(needle.toLowerCase())
  if (at < 0) throw new Error(`"${needle}" not in segment ${segmentIndex}`)
  const start = Array.from(seg.text.slice(0, at)).length
  return { segmentIndex, start, end: start + Array.from(needle).length }
}

type Conf = "low" | "medium" | "high"
export const f = <T>(value: T, citations: Citation[], confidence: Conf = "high") => ({ value, confidence, citations })

/** A complete, well-formed extraction of SEGMENTS covering every approved proposal kind. */
export function fullOutput(segments: FixtureSegment[] = SEGMENTS, startIso = "2099-12-04T09:00:00-08:00") {
  return {
    proposals: [
      {
        kind: "customer",
        name: f("Jordan Rivera", [cite(segments, 1, "Jordan Rivera")]),
        phone: f("+1 555 014 2988", [cite(segments, 1, "plus one five five five zero one four two nine eight eight")]),
        email: f("jordan.rivera@example.test", [cite(segments, 1, "jordan dot rivera at example dot test")]),
      },
      {
        kind: "vehicle",
        year: f(2021, [cite(segments, 2, "2021")]),
        make: f("Tesla", [cite(segments, 2, "Tesla")]),
        model: f("Model 3", [cite(segments, 2, "Model 3")]),
        color: f("black", [cite(segments, 2, "black")]),
      },
      {
        kind: "service_request",
        service: f("Ceramic coating and full interior detail", [cite(segments, 2, "a ceramic coating and a full interior detail")]),
        condition: f("Light swirl marks; rock chip on the hood", [cite(segments, 3, "light swirl marks and there is a rock chip on the hood")], "medium"),
        location: f("Customer's home in Fictionville", [cite(segments, 3, "at my home in Fictionville")]),
      },
      {
        kind: "timing",
        preferredTiming: f("Mornings", [cite(segments, 4, "Mornings work best")]),
        constraints: f("Not Tuesdays", [cite(segments, 4, "I can't do Tuesdays")]),
      },
      {
        kind: "lead",
        source: f("phone", [cite(segments, 1, "this is Jordan Rivera")]),
        stage: f("needs_quote", [cite(segments, 5, "send you a quote")]),
        ownerHint: f("Sam", [cite(segments, 0, "this is Sam")], "medium"),
        nextAction: f("Send quote", [cite(segments, 5, "send you a quote")]),
      },
      {
        kind: "quote_draft",
        services: f(["ceramic coating", "full interior detail"], [cite(segments, 2, "a ceramic coating and a full interior detail")]),
        notes: f("Customer asked for coating plus interior", [cite(segments, 2, "ceramic coating")]),
      },
      {
        kind: "appointment_draft",
        start: f(startIso, [cite(segments, 5, "Friday December 4th at 9 am")]),
        durationMinutes: f(180, [cite(segments, 5, "180 minutes")]),
        service: f("Ceramic coating", [cite(segments, 2, "ceramic coating")]),
      },
      {
        kind: "followup_task",
        title: f("Follow up about the quote", [cite(segments, 7, "follow up with you on Monday about the quote")]),
      },
      {
        kind: "message_draft",
        channel: "sms",
        body: f("Hi Jordan, we have your quote request and will text you a morning time shortly.", [cite(segments, 4, "I'd like a text, not a call")], "medium"),
      },
      {
        kind: "memory_candidate",
        scope: "customer",
        preference: f("Prefers drop-off after 9 am", [cite(segments, 6, "I always prefer drop-off after nine in the morning")]),
      },
    ],
  }
}

/** Scripted seam. `script` may return output (wrapped as ok) or a full ExtractorResult. */
export class FixtureExtractor implements CallExtractor {
  readonly id: string
  readonly version: string
  calls = 0
  lastInput: ExtractorInput | null = null
  constructor(
    private readonly script: (input: ExtractorInput) => unknown | ExtractorResult | Promise<unknown | ExtractorResult>,
    opts: { id?: string; version?: string } = {},
  ) {
    this.id = opts.id ?? "fixture"
    this.version = opts.version ?? "1"
  }
  async extract(input: ExtractorInput): Promise<ExtractorResult> {
    this.calls++
    this.lastInput = input
    const out = await this.script(input)
    if (out && typeof out === "object" && "ok" in out && typeof (out as { ok: unknown }).ok === "boolean") return out as ExtractorResult
    return { ok: true, output: out }
  }
}

import { z } from "zod"

import type { EmployeeBrief } from "@/lib/super-agent/brief"

const injection =
  /ignore (all |any |previous |prior )?instructions|you are now|grant (yourself |me )?permission|system prompt|approved for publication/i

export const researchSourceSchema = z
  .object({
    id: z.string().trim().min(1).max(40),
    title: z.string().trim().min(3).max(160),
    url: z.string().trim().url().max(300),
    excerpt: z.string().trim().min(10).max(800),
  })
  .strict()

export type ResearchSource = z.infer<typeof researchSourceSchema>

/** Starter sources only. They are not a live web lookup or an official award. */
export const RESEARCH_FIXTURES: ResearchSource[] = [
  {
    id: "programs-overview",
    title: "Small-business programs overview (starter source)",
    url: "https://example.com/gradia-research/programs",
    excerpt:
      "Eligibility depends on location, size, and ownership. This starter note is not an award or a ranking.",
  },
  {
    id: "local-visibility",
    title: "Local visibility checklist (starter source)",
    url: "https://example.com/gradia-research/visibility",
    excerpt:
      "Check the business name, hours, service area, and website for mismatches. Confirm each item on the real profile before changing it.",
  },
]

export const researchReportSchema = z
  .object({
    summary: z.string().min(1).max(600),
    findings: z
      .array(
        z
          .object({
            claim: z.string().min(1).max(400),
            source_title: z.string().min(1).max(160),
            uncertainty: z.string().min(1).max(300),
          })
          .strict()
      )
      .max(6),
    rejected_instructions: z.array(z.string().min(1).max(40)).max(6),
    missing_connections: z.array(z.string().min(1).max(120)).max(8),
    approval_status: z.literal("waiting_for_review"),
    published: z.literal(false),
  })
  .strict()

export type ResearchReport = z.infer<typeof researchReportSchema>

export type ResearchRunResult = {
  status: "ready" | "blocked"
  steps: string[]
  report: ResearchReport
}

/**
 * One bounded research pass. Sources are data. Text inside them cannot
 * grant permission, publish a result, or mark the report approved.
 */
export function executeResearch(
  brief: EmployeeBrief,
  sources: unknown,
  connected: readonly string[] = []
): ResearchRunResult {
  const parsed = z.array(researchSourceSchema).max(6).parse(sources)
  const missing = brief.connections_needed.filter((name) => !connected.includes(name))
  const rejected: string[] = []
  const usable: ResearchSource[] = []
  for (const source of parsed) {
    if (injection.test(source.excerpt) || injection.test(source.title)) {
      rejected.push(source.id)
      continue
    }
    usable.push(source)
  }

  if (missing.length > 0) {
    return {
      status: "blocked",
      steps: ["Check required connections", "Stop before using an outside account"],
      report: researchReportSchema.parse({
        summary: `Research for ${brief.name} did not run. A required connection is not available.`,
        findings: [],
        rejected_instructions: rejected,
        missing_connections: missing,
        approval_status: "waiting_for_review",
        published: false,
      }),
    }
  }

  const findings = usable.slice(0, 4).map((source) => ({
    claim: source.excerpt.slice(0, 280),
    source_title: source.title,
    uncertainty: "This is a supplied starter source, not a live lookup or a verified fact.",
  }))

  return {
    status: findings.length > 0 ? "ready" : "blocked",
    steps: ["Read the saved job", "Use only supplied sources", "Hold the report for review"],
    report: researchReportSchema.parse({
      summary: findings.length
        ? `Research notes for ${brief.name}. Nothing was published or sent.`
        : "No usable sources were available, so there is no report.",
      findings,
      rejected_instructions: rejected,
      missing_connections: [],
      approval_status: "waiting_for_review",
      published: false,
    }),
  }
}

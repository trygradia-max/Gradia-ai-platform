import { z } from "zod"

import { ACTIONS, modes, type Operation } from "@/lib/control-center/policy"

/**
 * The strict Agent definition vocabulary, kept free of server-only imports so the builder
 * UI validates against the SAME schema the server enforces. `definition.ts` re-exports it.
 */
const id = z.string().uuid()
const mode = z.enum(modes)
const operationNames = Object.keys(ACTIONS) as [Operation, ...Operation[]]
const operation = z.enum(operationNames)

const toolGrantSchema = z.object({
  operation,
  maximumMode: mode,
}).strict()

const scheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual") }).strict(),
  z.object({
    kind: z.literal("event"),
    event: z.enum(["lead.received", "message.received", "appointment.changed", "approval.resolved"]),
  }).strict(),
  z.object({
    kind: z.literal("interval"),
    everyMinutes: z.number().int().min(15).max(10_080),
  }).strict(),
])

/**
 * Owner-authored configuration only. Provider names, credentials, system prompts,
 * role identity and raw tool schemas are intentionally absent. They are Gradia
 * control-plane concerns and can never be granted by model output or request data.
 */
export const agentDefinitionDraftSchema = z.object({
  schemaVersion: z.literal(1),
  key: z.string().trim().regex(/^[a-z][a-z0-9-]{2,63}$/),
  revision: z.number().int().positive(),
  lifecycle: z.enum(["draft", "active", "paused", "blocked"]),
  job: z.object({
    roleLabel: z.string().trim().min(2).max(80),
    goal: z.string().trim().min(8).max(1_000),
    expectedOutcomes: z.array(z.string().trim().min(3).max(240)).min(1).max(8),
    stopConditions: z.array(z.string().trim().min(3).max(240)).min(1).max(12),
  }).strict(),
  knowledge: z.object({
    sourceIds: z.array(id).max(50),
    includeShopKnowledge: z.boolean(),
    includeCustomerMemory: z.boolean(),
    maxResultsPerQuery: z.number().int().min(1).max(20),
  }).strict(),
  tools: z.array(toolGrantSchema).max(operationNames.length),
  schedule: scheduleSchema,
  limits: z.object({
    maximumStepsPerRun: z.number().int().min(1).max(30),
    maximumRuntimeSeconds: z.number().int().min(5).max(900),
    maximumCreditsPerRun: z.number().int().min(0).max(100_000),
    maximumRunsPerDay: z.number().int().min(1).max(1_440),
    maximumConcurrentRuns: z.literal(1),
  }).strict(),
  routing: z.object({
    strategy: z.enum(["cost_aware", "quality_first"]),
    semanticCache: z.boolean(),
  }).strict(),
}).strict().superRefine((draft, context) => {
  const seen = new Set<Operation>()
  for (const grant of draft.tools) {
    if (seen.has(grant.operation)) {
      context.addIssue({ code: "custom", message: `Duplicate tool grant: ${grant.operation}`, path: ["tools"] })
    }
    seen.add(grant.operation)
    const definition = ACTIONS[grant.operation]
    if ((definition.initial === "read" || definition.initial === "suggest") && modes.indexOf(grant.maximumMode) > modes.indexOf(definition.initial)) {
      context.addIssue({ code: "custom", message: `${grant.operation} cannot exceed ${definition.initial}`, path: ["tools"] })
    }
  }
})

export type AgentDefinitionDraft = z.infer<typeof agentDefinitionDraftSchema>

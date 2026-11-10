import { agentDefinitionDraftSchema, type AgentDefinitionDraft } from "@/lib/agent-os/definition-schema"
import { ACTIONS, modes, type Mode, type Operation } from "@/lib/control-center/policy"

/**
 * Editable builder state. Numbers are held as strings so a half-typed value is never
 * silently coerced; conversion to the strict Agent definition happens only in
 * `toDefinitionInput`, which runs the SAME schema the server enforces.
 */
export type FormState = {
  key: string
  job: { roleLabel: string; goal: string; expectedOutcomes: string[]; stopConditions: string[] }
  knowledge: { sourceIds: string[]; includeShopKnowledge: boolean; includeCustomerMemory: boolean; maxResultsPerQuery: string }
  tools: { operation: Operation; maximumMode: Mode }[]
  schedule: { kind: "manual" } | { kind: "event"; event: Extract<AgentDefinitionDraft["schedule"], { kind: "event" }>["event"] } | { kind: "interval"; everyMinutes: string }
  limits: { maximumStepsPerRun: string; maximumRuntimeSeconds: string; maximumCreditsPerRun: string; maximumRunsPerDay: string }
  routing: { strategy: AgentDefinitionDraft["routing"]["strategy"]; semanticCache: boolean }
}

export const LIMIT_BOUNDS = {
  maximumStepsPerRun: { min: 1, max: 30 },
  maximumRuntimeSeconds: { min: 5, max: 900 },
  maximumCreditsPerRun: { min: 0, max: 100_000 },
  maximumRunsPerDay: { min: 1, max: 1_440 },
} as const
export const INTERVAL_BOUNDS = { min: 15, max: 10_080 } as const
export const JOB_BOUNDS = {
  roleLabel: { min: 2, max: 80 }, goal: { min: 8, max: 1_000 },
  outcomes: { minItems: 1, maxItems: 8, min: 3, max: 240 },
  stops: { minItems: 1, maxItems: 12, min: 3, max: 240 },
} as const
export const MAX_RESULTS_BOUNDS = { min: 1, max: 20 } as const

/** `key` is the definition's stable machine name (lowercase, starts with a letter, 3–64 chars). */
export function deriveDefinitionKey(name: string, agentId: string): string {
  const slug = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/^[^a-z]+/, "")
  const suffix = agentId.replace(/-/g, "").slice(0, 6).replace(/^[^a-z]/, "a")
  const base = (slug || "agent").slice(0, 50).replace(/-+$/g, "")
  return `${base || "agent"}-${suffix}`
}

/**
 * A complete, conservative starting point: no knowledge, no tools, manual schedule,
 * low bounded limits, concurrency 1 (implicit), cost-aware routing. The job fields are
 * deliberately empty: the owner must supply them before the schema accepts a save.
 */
export function seedForm(key: string): FormState {
  return {
    key,
    job: { roleLabel: "", goal: "", expectedOutcomes: [""], stopConditions: [""] },
    knowledge: { sourceIds: [], includeShopKnowledge: false, includeCustomerMemory: false, maxResultsPerQuery: "4" },
    tools: [],
    schedule: { kind: "manual" },
    limits: { maximumStepsPerRun: "5", maximumRuntimeSeconds: "60", maximumCreditsPerRun: "10", maximumRunsPerDay: "10" },
    routing: { strategy: "cost_aware", semanticCache: false },
  }
}

export function fromDefinition(definition: AgentDefinitionDraft): FormState {
  const schedule = definition.schedule
  return {
    key: definition.key,
    job: {
      roleLabel: definition.job.roleLabel,
      goal: definition.job.goal,
      expectedOutcomes: [...definition.job.expectedOutcomes],
      stopConditions: [...definition.job.stopConditions],
    },
    knowledge: {
      sourceIds: [...definition.knowledge.sourceIds],
      includeShopKnowledge: definition.knowledge.includeShopKnowledge,
      includeCustomerMemory: definition.knowledge.includeCustomerMemory,
      maxResultsPerQuery: String(definition.knowledge.maxResultsPerQuery),
    },
    tools: definition.tools.map((tool) => ({ operation: tool.operation, maximumMode: tool.maximumMode })),
    schedule: schedule.kind === "interval" ? { kind: "interval", everyMinutes: String(schedule.everyMinutes) } : schedule.kind === "event" ? { kind: "event", event: schedule.event } : { kind: "manual" },
    limits: {
      maximumStepsPerRun: String(definition.limits.maximumStepsPerRun),
      maximumRuntimeSeconds: String(definition.limits.maximumRuntimeSeconds),
      maximumCreditsPerRun: String(definition.limits.maximumCreditsPerRun),
      maximumRunsPerDay: String(definition.limits.maximumRunsPerDay),
    },
    routing: { ...definition.routing },
  }
}

const INTEGER = /^\d{1,9}$/
const toInt = (value: string): number => (INTEGER.test(value.trim()) ? Number(value.trim()) : Number.NaN)

export type FieldErrors = Record<string, string>
export type DefinitionInputBody = Omit<AgentDefinitionDraft, "revision" | "lifecycle">

function isBlank(value: string): boolean {
  return value.trim().length === 0
}

/** Builds the exact body `saveAgentDefinitionRevision` expects, or the per-field errors. */
export function toDefinitionInput(form: FormState): { ok: true; definition: DefinitionInputBody } | { ok: false; errors: FieldErrors } {
  const candidate = {
    schemaVersion: 1,
    key: form.key,
    job: {
      roleLabel: form.job.roleLabel.trim(),
      goal: form.job.goal.trim(),
      // Blank rows are not content; they are dropped, and "add at least one" is reported if none remain.
      expectedOutcomes: form.job.expectedOutcomes.filter((v) => !isBlank(v)).map((v) => v.trim()),
      stopConditions: form.job.stopConditions.filter((v) => !isBlank(v)).map((v) => v.trim()),
    },
    knowledge: {
      sourceIds: [...form.knowledge.sourceIds],
      includeShopKnowledge: form.knowledge.includeShopKnowledge,
      includeCustomerMemory: form.knowledge.includeCustomerMemory,
      maxResultsPerQuery: toInt(form.knowledge.maxResultsPerQuery),
    },
    tools: form.tools.map((tool) => ({ operation: tool.operation, maximumMode: tool.maximumMode })),
    schedule:
      form.schedule.kind === "interval"
        ? { kind: "interval", everyMinutes: toInt(form.schedule.everyMinutes) }
        : form.schedule.kind === "event"
          ? { kind: "event", event: form.schedule.event }
          : { kind: "manual" },
    limits: {
      maximumStepsPerRun: toInt(form.limits.maximumStepsPerRun),
      maximumRuntimeSeconds: toInt(form.limits.maximumRuntimeSeconds),
      maximumCreditsPerRun: toInt(form.limits.maximumCreditsPerRun),
      maximumRunsPerDay: toInt(form.limits.maximumRunsPerDay),
      maximumConcurrentRuns: 1,
    },
    routing: { ...form.routing },
  }
  const parsed = agentDefinitionDraftSchema.safeParse({ ...candidate, revision: 1, lifecycle: "draft" })
  if (parsed.success) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { revision: _revision, lifecycle: _lifecycle, ...definition } = parsed.data
    return { ok: true, definition }
  }
  const errors: FieldErrors = {}
  for (const issue of parsed.error.issues) {
    const path = issue.path.join(".")
    if (!(path in errors)) errors[path] = messageFor(path, issue.code, issue.message)
  }
  // A blank outcome/stop row inside a non-empty list is reported on the list, not hidden.
  return { ok: false, errors }
}

function messageFor(path: string, code: string, fallback: string): string {
  const range = (min: number, max: number) => `Use ${min.toLocaleString("en-US")}–${max.toLocaleString("en-US")}.`
  const textRange = (min: number, max: number) => `Use ${min}–${max.toLocaleString("en-US")} characters.`
  if (path === "key") return "This agent's internal name is invalid. Reload and try again."
  if (path === "job.roleLabel") return textRange(JOB_BOUNDS.roleLabel.min, JOB_BOUNDS.roleLabel.max)
  if (path === "job.goal") return textRange(JOB_BOUNDS.goal.min, JOB_BOUNDS.goal.max)
  if (path === "job.expectedOutcomes") return `Add ${JOB_BOUNDS.outcomes.minItems}–${JOB_BOUNDS.outcomes.maxItems} measurable outcomes.`
  if (path.startsWith("job.expectedOutcomes.")) return textRange(JOB_BOUNDS.outcomes.min, JOB_BOUNDS.outcomes.max)
  if (path === "job.stopConditions") return `Add ${JOB_BOUNDS.stops.minItems}–${JOB_BOUNDS.stops.maxItems} stop conditions.`
  if (path.startsWith("job.stopConditions.")) return textRange(JOB_BOUNDS.stops.min, JOB_BOUNDS.stops.max)
  if (path === "knowledge.maxResultsPerQuery") return range(MAX_RESULTS_BOUNDS.min, MAX_RESULTS_BOUNDS.max)
  if (path === "knowledge.sourceIds") return "Select up to 50 sources."
  if (path === "schedule.everyMinutes") return `Choose ${INTERVAL_BOUNDS.min} minutes to 7 days (${INTERVAL_BOUNDS.min}–${INTERVAL_BOUNDS.max.toLocaleString("en-US")} minutes).`
  if (path === "tools") return "A selected tool is not allowed at that level."
  const limit = path.replace(/^limits\./, "") as keyof typeof LIMIT_BOUNDS
  if (path.startsWith("limits.") && limit in LIMIT_BOUNDS) return range(LIMIT_BOUNDS[limit].min, LIMIT_BOUNDS[limit].max)
  return code === "invalid_type" ? "Enter a whole number." : fallback
}

/** Stable text of the editable state; equality means "no unsaved changes". */
export function formSnapshot(form: FormState): string {
  return JSON.stringify({
    ...form,
    job: { ...form.job, roleLabel: form.job.roleLabel.trim(), goal: form.job.goal.trim() },
  })
}

export const isDirty = (current: FormState, baseline: FormState): boolean => formSnapshot(current) !== formSnapshot(baseline)

/** Which operations a saved-definition edit may still request (the full Control Center catalog). */
export const ALL_OPERATIONS = Object.keys(ACTIONS) as Operation[]

export function isMode(value: string): value is Mode {
  return (modes as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// Request ids: one UUID per save click, reused only for an UNCHANGED retry.
// ---------------------------------------------------------------------------

export type RequestIdTracker = {
  /** The id for this exact (agent, parent revision, content). A changed payload always gets a fresh id. */
  idFor(fingerprint: string): string
  /** Forget the id after a definitive success. */
  settle(): void
}

export function createRequestIdTracker(generate: () => string): RequestIdTracker {
  let last: { fingerprint: string; id: string } | null = null
  return {
    idFor(fingerprint) {
      if (last && last.fingerprint === fingerprint) return last.id
      last = { fingerprint, id: generate() }
      return last.id
    },
    settle() {
      last = null
    },
  }
}

export function saveFingerprint(agentId: string, parentRevision: number | null, definition: DefinitionInputBody): string {
  return JSON.stringify([agentId, parentRevision, definition])
}

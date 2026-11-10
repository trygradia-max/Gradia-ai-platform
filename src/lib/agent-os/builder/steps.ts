import type { BuilderStepKey, StepStatus } from "@/lib/agent-os/definition-dto"

export const STEP_ORDER: readonly BuilderStepKey[] = ["job", "knowledge", "tools", "limits", "schedule", "test", "activate"]

export const STEP_META: Record<BuilderStepKey, { label: string; blurb: string }> = {
  job: { label: "Job", blurb: "What this agent is for" },
  knowledge: { label: "Knowledge", blurb: "What it may read" },
  tools: { label: "Tools", blurb: "What it may do" },
  limits: { label: "Limits", blurb: "How much it may do" },
  schedule: { label: "Schedule", blurb: "When it runs" },
  test: { label: "Test", blurb: "Check it before it goes live" },
  activate: { label: "Activate", blurb: "Turn it on" },
}

export const STEP_STATUS_LABEL: Record<StepStatus, string> = {
  complete: "Complete",
  incomplete: "Not done",
  attention: "Needs attention",
  blocked: "Blocked",
}

export function isStepKey(value: unknown): value is BuilderStepKey {
  return typeof value === "string" && (STEP_ORDER as readonly string[]).includes(value)
}

/** Unknown, repeated or missing `step` falls back to the first step. */
export function parseStepParam(raw: string | string[] | undefined): BuilderStepKey {
  const value = Array.isArray(raw) ? raw[0] : raw
  return isStepKey(value) ? value : "job"
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A route/search id is only ever passed on when it is a well-formed UUID. */
export function parseUuidParam(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null
}

/** `/agents/[agentId]/revisions/[revision]`: positive safe integers only, no signs, decimals or padding tricks. */
export function parseRevisionParam(raw: string | string[] | undefined): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== "string" || !/^[1-9][0-9]{0,8}$/.test(value)) return null
  return Number(value)
}

export const nextStep = (step: BuilderStepKey): BuilderStepKey | null => STEP_ORDER[STEP_ORDER.indexOf(step) + 1] ?? null
export const previousStep = (step: BuilderStepKey): BuilderStepKey | null => STEP_ORDER[STEP_ORDER.indexOf(step) - 1] ?? null

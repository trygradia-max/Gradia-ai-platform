/**
 * Provider boundary — safe logging.
 *
 * The only thing the boundary ever logs is a closed record of enums and
 * numbers: task name, outcome, hold reason codes, duration. It cannot carry
 * customer text, prompts, model output, provider response bodies, error
 * messages, identifiers or credentials, because the type admits none of them
 * and the writer copies fields by name rather than serializing its argument.
 */

import { HOLD_REASONS, type HoldReason } from "./preflight"

export const BOUNDARY_TASKS = ["classify_sms", "classify_email", "draft_sms_reply", "draft_email_reply"] as const
export type BoundaryTask = (typeof BOUNDARY_TASKS)[number]

export type BoundaryLogEvent = {
  task: BoundaryTask
  stage: "preflight" | "model" | "output"
  outcome: "ok" | "held"
  reasons: readonly HoldReason[]
  durationMs?: number
}

export function logBoundary(event: BoundaryLogEvent): void {
  const reasons = event.reasons.filter((r) => (HOLD_REASONS as readonly string[]).includes(r))
  const line = {
    task: (BOUNDARY_TASKS as readonly string[]).includes(event.task) ? event.task : "unknown",
    stage: event.stage,
    outcome: event.outcome,
    reasons,
    ...(typeof event.durationMs === "number" ? { durationMs: Math.round(event.durationMs) } : {}),
  }
  if (event.outcome === "held") console.warn("[provider-boundary]", line)
  else console.info("[provider-boundary]", line)
}

/** For route catch blocks: the error CLASS only. Messages can embed customer text or provider bodies. */
export function safeErrorName(err: unknown): string {
  return err instanceof Error && /^[A-Za-z0-9_]{1,40}$/.test(err.name) ? err.name : "Error"
}

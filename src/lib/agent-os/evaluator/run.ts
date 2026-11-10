/**
 * Trusted evaluator orchestration. The ONLY inputs are ids. The definition, its hash and its memory
 * pins are loaded here from the immutable revision tables, the verdict is computed by the pure
 * suite, and evidence is written only through `recordTrustedAgentEvaluation` (service role,
 * `agent_definition_record_evaluation`). No caller can supply, edit or suggest a result.
 */
import type { SupabaseClient } from "@supabase/supabase-js"

import { agentDefinitionDraftSchema } from "@/lib/agent-os/definition-schema"
import { recordTrustedAgentEvaluation } from "@/lib/agent-os/definition-store"
import { EVALUATION_FIXTURE_SET_ID, EVALUATION_SUITE_VERSION, FIXTURE_SET_HASH, evaluateDefinition, type EvaluationOutcome } from "@/lib/agent-os/evaluator/suite"

type Db = { service: SupabaseClient }

export type EvaluationSummary = {
  evaluationId: string
  revision: number
  definitionHash: string
  suiteVersion: string
  passRate: number
  safetyPassed: boolean
  estimatedCredits: number
  completedAt: string
  /** Fixture ids that did not hold (empty when everything passed). Only present on a fresh run. */
  failedFixtures: { id: string; safety: boolean; detail: string }[] | null
}

export type RunEvaluationResult =
  | { ok: true; outcome: "recorded" | "replayed"; evaluation: EvaluationSummary }
  | { ok: false; code: "forbidden" | "unavailable" | "agent_not_found" | "revision_not_found" | "invalid_definition" }

/** One evaluation per (revision, suite version, fixture set): the key is derived, never supplied. */
export const evaluationKeyFor = () => `${EVALUATION_SUITE_VERSION}:${FIXTURE_SET_HASH.slice(0, 16)}`

type EvalRow = {
  id: string; revision: number; definition_hash: string; suite_version: string
  pass_rate: number | string; safety_passed: boolean; estimated_credits: number; completed_at: string
}
const summary = (row: EvalRow, failed: EvaluationSummary["failedFixtures"]): EvaluationSummary => ({
  evaluationId: row.id,
  revision: row.revision,
  definitionHash: row.definition_hash,
  suiteVersion: row.suite_version,
  passRate: Number(row.pass_rate),
  safetyPassed: row.safety_passed,
  estimatedCredits: row.estimated_credits,
  completedAt: row.completed_at,
  failedFixtures: failed,
})
const COLUMNS = "id,revision,definition_hash,suite_version,pass_rate,safety_passed,estimated_credits,completed_at"

async function existing(deps: Db, agentId: string, revision: number): Promise<EvalRow | null | "error"> {
  const res = await deps.service.from("agent_definition_evaluations").select(COLUMNS)
    .eq("agent_id", agentId).eq("revision", revision).eq("evaluation_key", evaluationKeyFor()).maybeSingle()
  if (res.error) return "error"
  return (res.data as EvalRow | null) ?? null
}

/**
 * Evaluate one saved revision for its owner. Safe to repeat and to run concurrently: the second
 * and later calls (including a racing one that loses the write) return the recorded result.
 */
export async function runTrustedEvaluation(
  deps: Db,
  input: { shopId: string; actorId: string; agentId: string; revision: number }
): Promise<RunEvaluationResult> {
  const role = await deps.service.rpc("agent_definition_actor_role", { p_shop: input.shopId, p_actor: input.actorId })
  if (role.error) return { ok: false, code: "unavailable" }
  if (role.data !== "owner") return { ok: false, code: "forbidden" }

  const rev = await deps.service.from("agent_definition_revisions").select("revision,definition,definition_hash")
    .eq("shop_id", input.shopId).eq("agent_id", input.agentId).eq("revision", input.revision).maybeSingle()
  if (rev.error) return { ok: false, code: "unavailable" }
  if (!rev.data) {
    const agent = await deps.service.from("custom_agents").select("id").eq("id", input.agentId).eq("shop_id", input.shopId).maybeSingle()
    if (agent.error) return { ok: false, code: "unavailable" }
    return { ok: false, code: agent.data ? "revision_not_found" : "agent_not_found" }
  }

  const prior = await existing(deps, input.agentId, input.revision)
  if (prior === "error") return { ok: false, code: "unavailable" }
  if (prior) return { ok: true, outcome: "replayed", evaluation: summary(prior, null) }

  const parsed = agentDefinitionDraftSchema.safeParse(rev.data.definition)
  if (!parsed.success) return { ok: false, code: "invalid_definition" }
  const pins = await deps.service.from("agent_definition_memory_pins").select("source_id")
    .eq("shop_id", input.shopId).eq("agent_id", input.agentId).eq("revision", input.revision)
  if (pins.error) return { ok: false, code: "unavailable" }

  const outcome: EvaluationOutcome = evaluateDefinition({
    definition: parsed.data,
    pinnedSourceIds: (pins.data ?? []).map(p => p.source_id as string),
  })

  const recorded = await recordTrustedAgentEvaluation(deps, {
    shopId: input.shopId,
    agentId: input.agentId,
    revision: input.revision,
    definitionHash: rev.data.definition_hash as string,
    evaluationKey: evaluationKeyFor(),
    suiteVersion: outcome.suiteVersion,
    fixtureSetId: EVALUATION_FIXTURE_SET_ID,
    fixtureHash: outcome.fixtureHash,
    passRate: outcome.passRate,
    safetyPassed: outcome.safetyPassed,
    estimatedCredits: outcome.estimatedCredits,
    costEvidence: outcome.costEvidence,
    completedAt: new Date().toISOString(),
  })

  if (!recorded.ok) {
    // A concurrent evaluation of the same revision won the write (same key, different clock):
    // that recorded result IS the result.
    if (recorded.code === "conflict") {
      const winner = await existing(deps, input.agentId, input.revision)
      if (winner && winner !== "error") return { ok: true, outcome: "replayed", evaluation: summary(winner, null) }
      return { ok: false, code: "unavailable" }
    }
    if (recorded.code === "forbidden" || recorded.code === "agent_not_found" || recorded.code === "revision_not_found") return { ok: false, code: recorded.code }
    return { ok: false, code: "unavailable" }
  }

  const row = await deps.service.from("agent_definition_evaluations").select(COLUMNS).eq("id", recorded.evaluationId).maybeSingle()
  if (row.error || !row.data) return { ok: false, code: "unavailable" }
  return { ok: true, outcome: recorded.outcome, evaluation: summary(row.data as EvalRow, outcome.failed) }
}

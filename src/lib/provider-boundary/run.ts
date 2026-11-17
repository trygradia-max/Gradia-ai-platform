/**
 * Provider boundary — one bounded model task.
 *
 * `runBoundaryTask` is the only way the SMS/email classifiers and drafters
 * reach a model. It owns: the deadline, the abort signal, strict schema
 * validation, output policy, and conversion of EVERY failure into a typed hold.
 * It never throws, never retries across models, and never logs content.
 *
 * Authority: the model returns data matching a schema the task defines. The task
 * schema deliberately has no field for tenant, recipient, channel, consent,
 * purpose, policy, tool, price, booking or execution; routes attach those from
 * trusted state after the result is accepted.
 */

import { ChatAnthropic } from "@langchain/anthropic"
import type { z } from "zod"

import { logBoundary, type BoundaryTask } from "./log"
import type { HoldReason } from "./preflight"

export type BoundaryMessage = { role: "system" | "user"; content: string }

export type BoundaryModelRequest = {
  task: BoundaryTask
  toolName: string
  schema: z.ZodType
  messages: BoundaryMessage[]
  temperature: number
  maxTokens: number
  signal: AbortSignal
}

/** Provider seam: returns the raw (unvalidated) structured value. Mocked in every test. */
export type BoundaryModelClient = (request: BoundaryModelRequest) => Promise<unknown>

export const MODEL_ID = "claude-haiku-4-5-20251001"

function anthropicKey(): string {
  const k = process.env.ANTHROPIC_API_KEY?.trim()
  if (!k) throw new Error("model credentials are not configured")
  return k
}

/** Default client: the existing Haiku structured-output call, with no hidden retry beyond one. */
export const anthropicBoundaryClient: BoundaryModelClient = async (req) => {
  const llm = new ChatAnthropic({
    model: MODEL_ID,
    temperature: req.temperature,
    maxTokens: req.maxTokens,
    apiKey: anthropicKey(),
    maxRetries: 1,
  }).withStructuredOutput(req.schema, { name: req.toolName })
  return llm.invoke(
    req.messages.map((m) => [m.role === "system" ? "system" : "human", m.content] as [string, string]),
    { signal: req.signal },
  )
}

let clientOverride: BoundaryModelClient | null = null

/** Test seam. Refuses to run in production so a stray import cannot swap the provider. */
export function setBoundaryModelClientForTests(client: BoundaryModelClient | null): void {
  if (process.env.NODE_ENV === "production") throw new Error("test seam is unavailable in production")
  clientOverride = client
}

export type BoundaryResult<T> =
  | { status: "ok"; value: T; invoked: true; durationMs: number }
  | { status: "held"; reason: HoldReason; reasons: HoldReason[]; invoked: boolean; durationMs: number }

export type BoundaryTaskSpec<TRaw, TOut> = {
  task: BoundaryTask
  toolName: string
  /** Strict schema (no unknown keys) for the raw model value. */
  schema: z.ZodType<TRaw>
  messages: BoundaryMessage[]
  temperature: number
  maxTokens: number
  timeoutMs: number
  /** Post-schema policy + sanitization. Return a hold reason to refuse the whole result. */
  accept: (value: TRaw) => { ok: true; value: TOut } | { ok: false; reason: HoldReason }
}

class BoundaryTimeout extends Error {
  constructor() {
    super("deadline")
    this.name = "BoundaryTimeout"
  }
}

export async function runBoundaryTask<TRaw, TOut>(
  spec: BoundaryTaskSpec<TRaw, TOut>,
  client: BoundaryModelClient = clientOverride ?? anthropicBoundaryClient,
): Promise<BoundaryResult<TOut>> {
  const started = Date.now()
  const elapsed = () => Date.now() - started
  const held = (reason: HoldReason, stage: "model" | "output"): BoundaryResult<TOut> => {
    logBoundary({ task: spec.task, stage, outcome: "held", reasons: [reason], durationMs: elapsed() })
    return { status: "held", reason, reasons: [reason], invoked: true, durationMs: elapsed() }
  }

  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let raw: unknown
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new BoundaryTimeout())
      }, spec.timeoutMs)
    })
    raw = await Promise.race([
      client({
        task: spec.task,
        toolName: spec.toolName,
        schema: spec.schema,
        messages: spec.messages,
        temperature: spec.temperature,
        maxTokens: spec.maxTokens,
        signal: controller.signal,
      }),
      deadline,
    ])
  } catch (err) {
    // Provider failure, timeout or abort: a hold, never a negative classification.
    const timedOut = err instanceof BoundaryTimeout || (err instanceof Error && err.name === "AbortError")
    return held(timedOut ? "provider_timeout" : "provider_failure", "model")
  } finally {
    if (timer) clearTimeout(timer)
  }

  const parsed = spec.schema.safeParse(raw)
  if (!parsed.success) return held("malformed_output", "output")

  let accepted: { ok: true; value: TOut } | { ok: false; reason: HoldReason }
  try {
    accepted = spec.accept(parsed.data)
  } catch {
    return held("malformed_output", "output")
  }
  if (!accepted.ok) return held(accepted.reason, "output")

  logBoundary({ task: spec.task, stage: "output", outcome: "ok", reasons: [], durationMs: elapsed() })
  return { status: "ok", value: accepted.value, invoked: true, durationMs: elapsed() }
}

/** A hold decided before any model call (preflight or invalid input): no provider was invoked. */
export function heldBeforeModel<T>(task: BoundaryTask, reasons: readonly HoldReason[]): BoundaryResult<T> {
  logBoundary({ task, stage: "preflight", outcome: "held", reasons })
  const list: HoldReason[] = reasons.length ? [...reasons] : ["malformed_output"]
  return { status: "held", reason: list[0], reasons: list, invoked: false, durationMs: 0 }
}

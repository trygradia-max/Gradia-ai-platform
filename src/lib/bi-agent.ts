/**
 * BI chat agent — streaming variant.
 *
 * Calls Anthropic's Messages API with stream=true on every turn,
 * parses the SSE event stream into our own higher-level events
 * (text_delta, tool_start, tool_end, done, error), and yields them
 * as an async iterable.
 *
 * Tool calls happen mid-loop: we capture them from the stream, run
 * the tool against shop-scoped Supabase, and feed the result back
 * into another streaming call. Bound to MAX_TURNS to prevent runaway
 * tool chains.
 *
 * Safety: every tool handler is read-only and shop-scoped (see
 * BI_TOOLS). The model can't write or escape the shop's data.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

import { BI_TOOLS, findBiTool } from "@/lib/bi-tools"

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages"
const ANTHROPIC_VERSION = "2023-06-01"
const MODEL = "claude-sonnet-4-6"
const MAX_TURNS = 6
const MAX_TOKENS = 1024

const SYSTEM_PROMPT = `You are Gradia, the AI partner for an auto detailing shop. The shop owner is asking you a question about their business.

Tone rules:
- Speak as "we" and "us" — never "I". You're their partner, not a separate service.
- Warm, confident, specific. Concrete numbers when the tools give them.
- Brief. The owner is on their phone between jobs.

Answering rules:
- ALWAYS use the tools when the question is about data we have. Don't guess counts or trends — call the tool.
- When a tool returns numbers, restate them in plain English ("3 leads came in this week, 2 still in 'new' status").
- When a tool returns matches from search_memory, summarize what people asked about, naming the customer when known. Quote short snippets when they're vivid.
- If the question is outside what the tools can answer (revenue, pricing comparisons across shops, predictions, etc.), say so warmly and offer what we CAN answer.
- If a tool returns empty results, say so honestly — "no leads this week yet" beats inventing data.
- If the question is off-topic (general chat, sports, the weather), redirect warmly back to the shop.

Never invent customer names, vehicle details, prices, or counts that the tools didn't return.`

// ---------- Types ----------

type AnthropicTextBlock = { type: "text"; text: string }
type AnthropicToolUseBlock = {
  type: "tool_use"
  id: string
  name: string
  input: Record<string, unknown>
}
type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock

export type ChatMessage = {
  role: "user" | "assistant"
  content: string
}

type WireToolResult = {
  type: "tool_result"
  tool_use_id: string
  content: string
  is_error?: boolean
}

type WireMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: AnthropicContentBlock[] }
  | { role: "user"; content: WireToolResult[] }

/** High-level events the agent yields. Route + client both consume these. */
export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; name: string }
  | { type: "tool_end"; name: string; ok: boolean }
  | { type: "done" }
  | { type: "error"; message: string }

function apiKey(): string {
  const k = process.env.ANTHROPIC_API_KEY?.trim()
  if (!k) throw new Error("ANTHROPIC_API_KEY is not configured")
  return k
}

function buildToolDefinitions() {
  return BI_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: z.toJSONSchema(tool.schema),
  }))
}

// ---------- SSE parsing of Anthropic's stream ----------

type StreamTurnResult = {
  /** Reassembled content blocks (text + tool_use) from this turn. */
  blocks: AnthropicContentBlock[]
  /** From the final message_delta event. */
  stopReason: string | null
}

type StreamingState = {
  blocks: AnthropicContentBlock[]
  /** Per-index assembly buffer for tool_use inputs (JSON arrives in shards). */
  partialJson: Record<number, string>
}

/**
 * Reads Anthropic's SSE response and yields our text_delta events as
 * they arrive. Resolves with the fully assembled content blocks once
 * the message_stop event lands, so the caller can dispatch tool calls.
 */
async function* streamOneTurn(
  messages: WireMessage[]
): AsyncGenerator<AgentEvent, StreamTurnResult, void> {
  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "x-api-key": apiKey(),
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools: buildToolDefinitions(),
      messages,
      stream: true,
    }),
  })

  if (!res.ok || !res.body) {
    const errText = await res.text()
    throw new Error(`Anthropic (${res.status}): ${errText.slice(0, 300)}`)
  }

  const state: StreamingState = { blocks: [], partialJson: {} }
  let stopReason: string | null = null

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // SSE events end with double-newline. Process every complete one.
    let separatorIndex = buffer.indexOf("\n\n")
    while (separatorIndex !== -1) {
      const eventChunk = buffer.slice(0, separatorIndex)
      buffer = buffer.slice(separatorIndex + 2)

      const dataLine = eventChunk
        .split("\n")
        .find((line) => line.startsWith("data:"))
      if (!dataLine) {
        separatorIndex = buffer.indexOf("\n\n")
        continue
      }

      let payload: unknown
      try {
        payload = JSON.parse(dataLine.slice(5).trim())
      } catch {
        separatorIndex = buffer.indexOf("\n\n")
        continue
      }

      const yields = applyStreamEvent(payload, state)
      for (const event of yields.events) yield event
      if (yields.stopReason !== undefined) stopReason = yields.stopReason

      separatorIndex = buffer.indexOf("\n\n")
    }
  }

  // Finalize any pending tool_use input_json by parsing the assembled string.
  for (let i = 0; i < state.blocks.length; i++) {
    const block = state.blocks[i]
    if (block?.type === "tool_use") {
      const raw = state.partialJson[i] ?? ""
      try {
        block.input = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      } catch {
        block.input = {}
      }
    }
  }

  return { blocks: state.blocks, stopReason }
}

type AnthropicStreamEvent = {
  type: string
  index?: number
  content_block?: AnthropicContentBlock
  delta?: {
    type?: string
    text?: string
    partial_json?: string
    stop_reason?: string
  }
}

function applyStreamEvent(
  raw: unknown,
  state: StreamingState
): { events: AgentEvent[]; stopReason?: string | null } {
  const evt = raw as AnthropicStreamEvent
  const events: AgentEvent[] = []

  switch (evt.type) {
    case "content_block_start": {
      const idx = evt.index ?? state.blocks.length
      if (evt.content_block) {
        state.blocks[idx] = evt.content_block
        if (evt.content_block.type === "tool_use") {
          state.partialJson[idx] = ""
        }
      }
      return { events }
    }
    case "content_block_delta": {
      const idx = evt.index ?? 0
      if (evt.delta?.type === "text_delta" && evt.delta.text) {
        const block = state.blocks[idx]
        if (block?.type === "text") {
          block.text += evt.delta.text
        }
        events.push({ type: "text_delta", text: evt.delta.text })
      } else if (
        evt.delta?.type === "input_json_delta" &&
        typeof evt.delta.partial_json === "string"
      ) {
        state.partialJson[idx] =
          (state.partialJson[idx] ?? "") + evt.delta.partial_json
      }
      return { events }
    }
    case "message_delta": {
      const stopReason = evt.delta?.stop_reason ?? null
      return { events, stopReason }
    }
    default:
      // message_start, content_block_stop, message_stop, ping — no-op for us.
      return { events }
  }
}

// ---------- Tool execution ----------

async function runTool(
  supabase: SupabaseClient,
  shopId: string,
  block: AnthropicToolUseBlock
): Promise<{ content: string; isError: boolean }> {
  const tool = findBiTool(block.name)
  if (!tool) {
    return {
      content: JSON.stringify({ error: `Unknown tool: ${block.name}` }),
      isError: true,
    }
  }
  try {
    const result = await tool.handler(supabase, shopId, block.input)
    return { content: JSON.stringify(result), isError: false }
  } catch (err) {
    return {
      content: JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      }),
      isError: true,
    }
  }
}

// ---------- Public entry point ----------

/**
 * Streams events for the agent loop. Caller pipes these to the
 * client (SSE in /api/bi/chat) or aggregates them for a
 * non-streaming caller.
 */
export async function* streamBiAgent(input: {
  supabase: SupabaseClient
  shopId: string
  history: ChatMessage[]
}): AsyncGenerator<AgentEvent, void, void> {
  const messages: WireMessage[] = input.history.map((m) =>
    m.role === "assistant"
      ? { role: "assistant", content: [{ type: "text", text: m.content }] }
      : { role: "user", content: m.content }
  )

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const stream = streamOneTurn(messages)
      let turnResult: StreamTurnResult | null = null
      while (true) {
        const next = await stream.next()
        if (next.done) {
          turnResult = next.value
          break
        }
        yield next.value
      }

      const result = turnResult ?? { blocks: [], stopReason: null }
      messages.push({ role: "assistant", content: result.blocks })

      const toolUses = result.blocks.filter(
        (b): b is AnthropicToolUseBlock => b.type === "tool_use"
      )

      if (toolUses.length === 0 || result.stopReason === "end_turn") {
        yield { type: "done" }
        return
      }

      // Execute every tool call from this turn. Surface a status event
      // before and after each one so the client can render progress.
      const toolResults: WireToolResult[] = []
      for (const use of toolUses) {
        yield { type: "tool_start", name: use.name }
        const result = await runTool(input.supabase, input.shopId, use)
        toolResults.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: result.content,
          is_error: result.isError || undefined,
        })
        yield { type: "tool_end", name: use.name, ok: !result.isError }
      }
      messages.push({ role: "user", content: toolResults })
    }

    yield {
      type: "error",
      message:
        "We're chasing too many threads on that one — try a more specific question.",
    }
  } catch (err) {
    yield {
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

// ---------- Non-streaming convenience wrapper ----------

/**
 * Aggregates the streaming events into a final text + toolsUsed list.
 * Kept around for places that don't need real-time deltas (tests,
 * future cron-style "daily summary" jobs).
 */
export async function runBiAgent(input: {
  supabase: SupabaseClient
  shopId: string
  history: ChatMessage[]
}): Promise<{ text: string; toolsUsed: string[] }> {
  const chunks: string[] = []
  const toolsUsed: string[] = []
  let lastError: string | null = null

  for await (const event of streamBiAgent(input)) {
    if (event.type === "text_delta") chunks.push(event.text)
    else if (event.type === "tool_start") toolsUsed.push(event.name)
    else if (event.type === "error") lastError = event.message
  }

  const text = chunks.join("").trim()
  if (!text && lastError) {
    return { text: lastError, toolsUsed }
  }
  return { text: text || "We've got nothing to add.", toolsUsed }
}

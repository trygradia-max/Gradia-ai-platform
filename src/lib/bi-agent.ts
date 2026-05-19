/**
 * BI chat agent loop. Direct Anthropic Messages API (matches our
 * Stripe/Twilio/Aurinko hand-rolled fetch pattern; no LangChain
 * agent abstraction needed).
 *
 * Flow:
 *   1. POST messages + tool definitions to Anthropic.
 *   2. If the response has tool_use blocks, execute each tool against
 *      the shop-scoped Supabase client and feed the results back.
 *   3. Loop until the model emits a plain text response (stop_reason
 *      === "end_turn") or we hit MAX_TURNS.
 *   4. Return the final assistant text.
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

type AnthropicTextBlock = { type: "text"; text: string }
type AnthropicToolUseBlock = {
  type: "tool_use"
  id: string
  name: string
  input: Record<string, unknown>
}
type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock

type AnthropicResponse = {
  content: AnthropicContentBlock[]
  stop_reason: string
}

export type ChatMessage = {
  role: "user" | "assistant"
  content: string
}

type WireMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: AnthropicContentBlock[] }
  | {
      role: "user"
      content: {
        type: "tool_result"
        tool_use_id: string
        content: string
        is_error?: boolean
      }[]
    }

function apiKey(): string {
  const k = process.env.ANTHROPIC_API_KEY?.trim()
  if (!k) throw new Error("ANTHROPIC_API_KEY is not configured")
  return k
}

function buildToolDefinitions() {
  return BI_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    // zod v4 ships native JSON Schema conversion. Anthropic's tool
    // input_schema is a plain JSON Schema object.
    input_schema: z.toJSONSchema(tool.schema),
  }))
}

async function callAnthropic(messages: WireMessage[]): Promise<AnthropicResponse> {
  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "x-api-key": apiKey(),
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools: buildToolDefinitions(),
      messages,
    }),
  })
  const raw = await res.text()
  if (!res.ok) {
    throw new Error(`Anthropic error (${res.status}): ${raw.slice(0, 300)}`)
  }
  return JSON.parse(raw) as AnthropicResponse
}

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

function extractText(blocks: AnthropicContentBlock[]): string {
  return blocks
    .filter((b): b is AnthropicTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim()
}

/**
 * Run the BI agent against a conversation. The caller passes the full
 * conversation history (user + assistant turns); the agent appends
 * its tool-use sub-turns internally and returns the final assistant
 * text.
 */
export async function runBiAgent(input: {
  supabase: SupabaseClient
  shopId: string
  history: ChatMessage[]
}): Promise<{ text: string; toolsUsed: string[] }> {
  const messages: WireMessage[] = input.history.map((m) =>
    m.role === "assistant"
      ? { role: "assistant", content: [{ type: "text", text: m.content }] }
      : { role: "user", content: m.content }
  )

  const toolsUsed: string[] = []

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await callAnthropic(messages)

    // Persist the assistant turn (including any tool_use blocks) so the
    // next call has the same context Anthropic expects.
    messages.push({ role: "assistant", content: response.content })

    const toolUses = response.content.filter(
      (b): b is AnthropicToolUseBlock => b.type === "tool_use"
    )

    if (toolUses.length === 0 || response.stop_reason === "end_turn") {
      return {
        text: extractText(response.content) || "We've got nothing to add.",
        toolsUsed,
      }
    }

    // Execute every tool call from this turn, then push them all as a
    // single user tool_result message.
    const toolResults: WireMessage = {
      role: "user",
      content: [],
    }
    for (const use of toolUses) {
      toolsUsed.push(use.name)
      const result = await runTool(input.supabase, input.shopId, use)
      ;(toolResults.content as {
        type: "tool_result"
        tool_use_id: string
        content: string
        is_error?: boolean
      }[]).push({
        type: "tool_result",
        tool_use_id: use.id,
        content: result.content,
        is_error: result.isError || undefined,
      })
    }
    messages.push(toolResults)
  }

  return {
    text: "We're chasing too many threads on that one — try asking a more specific question.",
    toolsUsed,
  }
}

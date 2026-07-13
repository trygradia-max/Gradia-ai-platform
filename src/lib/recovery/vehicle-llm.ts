/**
 * C7 vehicle-string cleanup worker (GRADIA_CRM_FOUNDATION_SPEC §C7.5) — the
 * ONLY LLM use on a structured-CSV import: a combined vehicle cell the regex
 * couldn't read ("19 chevy silvy lifted", "Bimmer M3 comp"). Single-turn
 * Haiku with forced structured output, same pattern as extract.ts. It never
 * writes and never meters — the batch runner (csv-cleanup.ts) does both.
 */

import { ChatAnthropic } from "@langchain/anthropic"
import { ChatPromptTemplate } from "@langchain/core/prompts"
import { z } from "zod"

import type { ParsedVehicle } from "@/lib/vehicle"

const CLAUDE_MODEL = "claude-haiku-4-5-20251001"
const TOOL_NAME = "parse_vehicle"

const schema = z
  .object({
    year: z
      .number()
      .describe("4-digit model year; 0 when the text has none."),
    make: z
      .string()
      .describe(
        'Canonical manufacturer name ("Chevrolet", not "chevy"); empty string when no real vehicle make is present.'
      ),
    model: z
      .string()
      .describe('Model as written, cleaned ("Silverado 1500"); empty string if none.'),
    color: z
      .string()
      .describe('Capitalized color ("Black"); empty string if none.'),
  })
  .describe(
    "Structured vehicle from one messy spreadsheet cell. Extract only what the text supports — never guess a make from a model alone unless unambiguous (e.g. 'Silverado' → Chevrolet)."
  )

const prompt = ChatPromptTemplate.fromMessages([
  [
    "system",
    "You normalize messy vehicle descriptions from an auto-detailing shop's spreadsheet into structured fields. Expand nicknames (chevy → Chevrolet, VW → Volkswagen, bimmer/beemer → BMW, silvy → Silverado). Two-digit years get the obvious century. If the cell is not a vehicle at all, return empty fields.",
  ],
  ["human", `Parse this vehicle cell via the ${TOOL_NAME} tool.\n\nCELL: {cell}`],
])

function anthropicKey(): string {
  const k = process.env.ANTHROPIC_API_KEY?.trim()
  if (!k) throw new Error("ANTHROPIC_API_KEY is not configured")
  return k
}

export async function parseVehicleWithLlm(cell: string): Promise<ParsedVehicle> {
  const llm = new ChatAnthropic({
    model: CLAUDE_MODEL,
    temperature: 0,
    maxTokens: 256,
    apiKey: anthropicKey(),
  }).withStructuredOutput(schema, { name: TOOL_NAME })

  const raw = await prompt.pipe(llm).invoke({ cell: cell.trim().slice(0, 300) })
  const parsed = schema.parse(raw)
  const year =
    parsed.year >= 1900 && parsed.year <= 2100 ? Math.round(parsed.year) : null
  return {
    make: parsed.make.trim() || null,
    model: parsed.model.trim() || null,
    year,
    color: parsed.color.trim() || null,
  }
}

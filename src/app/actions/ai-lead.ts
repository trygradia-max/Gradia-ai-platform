"use server"

/**
 * Only invoke from explicit user actions (e.g. AI Lead "Process" button).
 * Do not call from useEffect or handlers that run while the user types.
 */

import { z } from "zod"

import {
  extractLeadFromRawText,
  type ExtractedLeadJson,
} from "@/lib/ai-service"

const rawSchema = z
  .string()
  .min(1, "Paste your note before processing.")
  .max(12_000, "Note is too long.")

export type ProcessRawLeadResult =
  | { ok: true; data: ExtractedLeadJson }
  | { ok: false; error: string }

export async function processRawLeadNote(
  raw: string
): Promise<ProcessRawLeadResult> {
  const lengthCheck = rawSchema.safeParse(raw)
  if (!lengthCheck.success) {
    return {
      ok: false,
      error: lengthCheck.error.issues[0]?.message ?? "Invalid input",
    }
  }

  try {
    const data = await extractLeadFromRawText(raw)
    return { ok: true, data }
  } catch (e) {
    const message =
      e instanceof Error ? e.message : "Could not process this note."
    return { ok: false, error: message }
  }
}

"use server"

/**
 * Only invoke from explicit user actions (e.g. AI Lead "Process" button).
 * Do not call from useEffect or handlers that run while the user types.
 *
 * P0-010 (audit M-1): this action calls Anthropic, so it carries the same
 * gates as the other owner LLM surfaces (whisper/BI chat) — session auth,
 * shop resolution, fail-closed plan/credit access, per-shop burst limit,
 * and a cost-visibility usage row. Unauthenticated callers are refused
 * before any model call.
 */

import { z } from "zod"

import {
  extractLeadFromRawText,
  type ExtractedLeadJson,
} from "@/lib/ai-service"
import {
  checkFeatureAccess,
  loadShopCreditFields,
  recordUsage,
} from "@/lib/credits"
import { getPricing, priceUsage } from "@/lib/pricing"
import { checkRateLimit } from "@/lib/rate-limit"
import { getOptionalShop } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"

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
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return { ok: false, error: "Sign-in expired — refresh and try again." }
  }

  const shop = await getOptionalShop()
  if (!shop) {
    return { ok: false, error: "We need to set up our shop first." }
  }

  // Fail-closed: an inactive plan or an exhausted credit balance stops the
  // model call before we spend a cent (same posture as Whisper/BI chat).
  const creditFields = await loadShopCreditFields(supabase, shop.id)
  if (!creditFields) {
    return { ok: false, error: "We need to set up our shop first." }
  }
  const access = await checkFeatureAccess(supabase, creditFields)
  if (!access.ok) {
    return { ok: false, error: access.reason }
  }

  const burst = await checkRateLimit(shop.id, "ai_lead")
  if (!burst.allowed) {
    return {
      ok: false,
      error: "Give us a second to catch up — try again shortly.",
    }
  }

  const lengthCheck = rawSchema.safeParse(raw)
  if (!lengthCheck.success) {
    return {
      ok: false,
      error: lengthCheck.error.issues[0]?.message ?? "Invalid input",
    }
  }

  try {
    const data = await extractLeadFromRawText(raw)
    await meterAiLeadExtraction(supabase, shop.id)
    return { ok: true, data }
  } catch (e) {
    const message =
      e instanceof Error ? e.message : "Could not process this note."
    return { ok: false, error: message }
  }
}

/** Cost visibility on the locked menu's classify SKU (retail 0 by design —
 *  wholesale lands in the ledger/margin report). `priceUsage` rounds
 *  credits UP to 1 even when retail is 0 (`Math.max(1, ceil(retail))`),
 *  so we pass credits: 0 explicitly — same contract as Twilio/Aurinko
 *  inbound classify. A dedicated AI-Lead SKU or repricing is a founder
 *  decision, not this ticket's. */
async function meterAiLeadExtraction(
  supabase: Awaited<ReturnType<typeof createClient>>,
  shopId: string
): Promise<void> {
  const priced = priceUsage(await getPricing(supabase), "inbound_classify", 1)
  await recordUsage(supabase, shopId, "inbound_classify", {
    credits: 0, // cost-visibility SKU — never spends shop credits
    wholesaleCost: priced.wholesale_cost,
    retailCost: priced.retail_cost,
  })
}

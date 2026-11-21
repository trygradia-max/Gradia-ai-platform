import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

import { reviewDetailSchema, reviewListSchema, type ReviewDetailResult, type ReviewList } from "./review-dto"

/**
 * Call Copilot review (PR F): the only readers the review surface uses.
 *
 * Each is a thin wrapper over ONE read-only database function that derives authority from the caller's own session
 * (an active owner, or a manager holding crm.read, of exactly the shop named) and returns only the minimum
 * the review needs. There is no table read here: browser roles have no grant on any call_copilot_* table, and this
 * module does not create a client of its own (the caller passes the signed-in session client).
 *
 * Fail closed: an error, an unreadable answer or a refusal is a typed non-success. The caller shows
 * "could not be verified", never an empty "all clear", and never offers an action.
 */

export type ReadOutcome<T> =
  | { status: "ok"; value: T }
  | { status: "not_found" }
  | { status: "forbidden" }
  | { status: "unavailable" }

const ids = z.object({ shopId: z.string().uuid(), callId: z.string().uuid().optional() })

function parseJson(data: unknown): unknown {
  if (typeof data !== "string") return data
  try {
    return JSON.parse(data)
  } catch {
    return null
  }
}

export async function readCallReviewList(
  db: SupabaseClient,
  input: { shopId: string; limit?: number; before?: { createdAt: string; id: string } | null },
): Promise<ReadOutcome<ReviewList>> {
  if (!ids.safeParse(input).success) return { status: "unavailable" }
  let res
  try {
    res = await db.rpc("call_copilot_review_list", {
      p_shop: input.shopId,
      p_limit: Math.min(Math.max(Math.trunc(input.limit ?? 20), 1), 25),
      p_before_created: input.before?.createdAt ?? null,
      p_before_id: input.before?.id ?? null,
    })
  } catch {
    return { status: "unavailable" }
  }
  if (res.error) return res.error.code === "42501" ? { status: "forbidden" } : { status: "unavailable" }
  const parsed = reviewListSchema.safeParse(parseJson(res.data))
  return parsed.success ? { status: "ok", value: parsed.data } : { status: "unavailable" }
}

export async function readCallReviewDetail(
  db: SupabaseClient,
  input: { shopId: string; callId: string; revision?: number | null },
): Promise<ReadOutcome<Extract<ReviewDetailResult, { found: true }>>> {
  if (!ids.safeParse(input).success || !input.callId) return { status: "unavailable" }
  const revision = input.revision == null ? null : Math.trunc(input.revision)
  if (revision !== null && (revision < 1 || revision > 100000)) return { status: "unavailable" }
  let res
  try {
    res = await db.rpc("call_copilot_review_detail", { p_shop: input.shopId, p_call: input.callId, p_revision: revision })
  } catch {
    return { status: "unavailable" }
  }
  if (res.error) return res.error.code === "42501" ? { status: "forbidden" } : { status: "unavailable" }
  const parsed = reviewDetailSchema.safeParse(parseJson(res.data))
  if (!parsed.success) return { status: "unavailable" }
  return parsed.data.found ? { status: "ok", value: parsed.data } : { status: "not_found" }
}

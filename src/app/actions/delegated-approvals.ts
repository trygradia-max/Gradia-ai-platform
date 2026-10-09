"use server"

import { revalidatePath } from "next/cache"

import { executeApproval } from "@/lib/approvals"
import { delegatedApprovalCommandSchema } from "@/lib/delegated-approvals"
import { requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

/**
 * Delegated manager approval of one queued text or email. The shop and action
 * ids are selectors only: the claim RPC proves the signed-in caller's live
 * grant in that shop, binds the approval to the exact message reviewed, and
 * the executor then applies every consent, opt-out and delivery check.
 */
export async function approveDelegatedMessage(
  input: unknown
): Promise<{ ok: boolean; message: string }> {
  const parsed = delegatedApprovalCommandSchema.safeParse(input)
  if (!parsed.success) return { ok: false, message: "Refresh and review the message again before approving." }
  const user = await requireUser()
  const c = parsed.data
  let executionClient
  try {
    executionClient = createServiceClient()
  } catch {
    return { ok: false, message: "Delegated approval is not available right now. Nothing was approved or sent." }
  }
  const session = await createClient()
  let result
  try {
    result = await executeApproval(session, c.actionId, c.shopId, { userId: user.id }, {
      delegated: { expectedReview: c.reviewHash, executionClient },
    })
  } catch {
    return { ok: false, message: "Result uncertain. Do not approve again; ask the shop owner to review this message." }
  }
  revalidatePath("/team/approvals")
  if (!result.ok) return { ok: false, message: result.error }
  if (result.status === "already_decided") return { ok: true, message: "This message was already decided. Nothing new was sent." }
  return { ok: true, message: "Approved and handed to the provider. This is not a delivery receipt." }
}

/**
 * Delegated manager rejection of one queued text or email. Session-only: the
 * RPC rechecks the live grant and the reviewed message, sends nothing and
 * consumes no sending authority. The owner can restore it from Approvals.
 */
export async function rejectDelegatedMessage(
  input: unknown
): Promise<{ ok: boolean; message: string }> {
  const parsed = delegatedApprovalCommandSchema.safeParse(input)
  if (!parsed.success) return { ok: false, message: "Refresh and review the message again before rejecting." }
  await requireUser()
  const c = parsed.data
  const session = await createClient()
  let data: Record<string, unknown> | null
  try {
    const result = await session.rpc("reject_delegated_message", {
      p_shop: c.shopId, p_action: c.actionId, p_expected: c.reviewHash,
    })
    if (result.error) return { ok: false, message: "Rejection not confirmed. Refresh and check the queue before trying again." }
    data = result.data as Record<string, unknown> | null
  } catch {
    return { ok: false, message: "Result uncertain. Refresh and check the queue before deciding again." }
  }
  revalidatePath("/team/approvals")
  if (data?.already_decided === true) return { ok: true, message: "This message was already decided. Nothing was sent by this action." }
  if (data?.id === c.actionId && data.shop_id === c.shopId) return { ok: true, message: "Rejected. Nothing was sent. The shop owner can restore it from Approvals." }
  const reasons: Record<string, string> = {
    actor_not_authorized: "Message approval for this shop is not delegated to your account.",
    owner_approval_required: "Only the shop owner can decide this kind of action.",
    review_changed: "This message changed or is being edited. Refresh and review it again.",
    delivery_review_required: "Sending was already attempted for this message. Use delivery review instead of rejecting it.",
    location_unavailable: "The workspace location could not be verified.",
  }
  return { ok: false, message: reasons[String(data?.denied)] ?? "Rejection not confirmed. Refresh and check the queue before trying again." }
}

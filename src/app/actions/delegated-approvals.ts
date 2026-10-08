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

"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { executeApproval, executeRejection } from "@/lib/approvals"
import { readCallReviewDetail } from "@/lib/call-copilot/review-read"
import { MAX_BULK } from "@/lib/call-copilot/review-model"
import { approveSelected, dismissProposal, type DecideDeps, type DecideResult } from "@/lib/call-review/decide"
import { getOptionalShop, requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"

/**
 * Call Copilot review: approve, approve-selected and dismiss.
 *
 * Every entry point is an untrusted POST. The client supplies only references (a call id, proposal ids and the
 * review token it was shown). Identity and the shop come from the signed-in session; the proposal, its action
 * and its state are re-read from the database; the shop owner is the only role that can approve (the approval claim
 * re-checks this in SQL). Nothing here writes a table or runs a tool: it calls the existing executor.
 *
 * The returned object is a small, closed shape built from the decision result (no database rows).
 */

const item = z.object({ proposalId: z.string().uuid(), reviewToken: z.string().regex(/^[0-9a-f]{64}$/) }).strict()
const one = z.object({ callId: z.string().uuid(), ...item.shape }).strict()
const many = z.object({ callId: z.string().uuid(), items: z.array(item).min(1).max(MAX_BULK) }).strict()

const FAILED: DecideResult = {
  ok: false, message: "That request could not be read. Refresh and try again. Nothing was approved.", steps: [], notAttempted: [], after: null,
}
const NOT_SIGNED_IN: DecideResult = {
  ok: false, message: "Only the shop owner can approve call proposals. Nothing was approved.", steps: [], notAttempted: [], after: null,
}

async function context(callId: string): Promise<{ deps: DecideDeps; shopId: string } | null> {
  const user = await requireUser()
  const shop = await getOptionalShop()
  if (!shop) return null
  const supabase = await createClient()
  const deps: DecideDeps = {
    readDetail: () => readCallReviewDetail(supabase, { shopId: shop.id, callId }),
    approve: (actionId) => executeApproval(supabase, actionId, shop.id, { userId: user.id }),
    dismiss: (actionId) => executeRejection(supabase, actionId, shop.id, { userId: user.id }),
  }
  return { deps, shopId: shop.id }
}

function revalidate(callId: string): void {
  revalidatePath(`/calls/copilot/${callId}`)
  revalidatePath("/calls/copilot")
  revalidatePath("/approvals")
  revalidatePath("/customers")
  revalidatePath("/dashboard")
}

/** Approve one proposal. The result is the executor's answer plus a fresh read; never a guess. */
export async function approveCallProposal(input: unknown): Promise<DecideResult> {
  const parsed = one.safeParse(input)
  if (!parsed.success) return FAILED
  const ctx = await context(parsed.data.callId)
  if (!ctx) return NOT_SIGNED_IN
  const result = await approveSelected(ctx.deps, [{ proposalId: parsed.data.proposalId, reviewToken: parsed.data.reviewToken }])
  revalidate(parsed.data.callId)
  return result
}

/**
 * Approve the selected proposals, one at a time, in dependency order, stopping at the first one that is not a confirmed
 * success. The whole selection is validated before anything runs.
 */
export async function approveSelectedCallProposals(input: unknown): Promise<DecideResult> {
  const parsed = many.safeParse(input)
  if (!parsed.success) return FAILED
  const ctx = await context(parsed.data.callId)
  if (!ctx) return NOT_SIGNED_IN
  const result = await approveSelected(ctx.deps, parsed.data.items)
  revalidate(parsed.data.callId)
  return result
}

/** Dismiss one proposal that is waiting on the owner. Sends nothing, changes no customer data. */
export async function dismissCallProposal(input: unknown): Promise<DecideResult> {
  const parsed = one.safeParse(input)
  if (!parsed.success) return FAILED
  const ctx = await context(parsed.data.callId)
  if (!ctx) return NOT_SIGNED_IN
  const result = await dismissProposal(ctx.deps, { proposalId: parsed.data.proposalId, reviewToken: parsed.data.reviewToken })
  revalidate(parsed.data.callId)
  return result
}

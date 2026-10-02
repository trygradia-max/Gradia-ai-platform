import { z } from "zod"
import type { SupabaseClient } from "@supabase/supabase-js"

const historySchema = z.object({
  workflow_id: z.string().uuid(),
  state: z.enum(["identity_review", "identity_linked"]),
  revision: z.number().int().positive(),
  channel: z.enum(["sms", "website_form", "meta", "synthetic"]),
  customer_id: z.string().uuid().nullable(),
  total: z.number().int().nonnegative(),
  items: z.array(z.object({
    revision: z.number().int().positive(),
    reason: z.enum(["identity_unresolved", "additional_evidence", "identity_confirmed"]),
    received_at: z.string(), recorded_at: z.string(), actor_id: z.string().uuid().nullable(),
    payload: z.record(z.string(), z.string()).nullable(),
    reviewed_customer: z.object({
      id: z.string().uuid(), name: z.string().nullable(),
      phone: z.string().nullable(), email: z.string().nullable(),
    }).nullable(),
  })),
})
export type IntakeHistory = z.infer<typeof historySchema>
export type IntakeHistoryResult = { ok: true; history: IntakeHistory } | { ok: false; changed: boolean }

/** Session-only read. Paging is anchored to a workflow revision, never cached. */
export async function loadIntakeHistory(
  db: SupabaseClient, shopId: string, workflowId: string,
  offset = 0, revision: number | null = null,
): Promise<IntakeHistoryResult> {
  if (![shopId, workflowId].every(id => z.string().uuid().safeParse(id).success)
    || !Number.isSafeInteger(offset) || offset < 0
    || (offset > 0 && revision === null)
    || (revision !== null && (!Number.isSafeInteger(revision) || revision < 1))) {
    return { ok: false, changed: false }
  }
  try {
    const result = await db.rpc("read_lead_intake_history", {
      p_shop: shopId, p_workflow: workflowId, p_offset: offset, p_limit: 20, p_revision: revision,
    })
    if (result.error) return { ok: false, changed: result.error.code === "PT409" }
    const parsed = historySchema.safeParse(result.data)
    if (!parsed.success || parsed.data.workflow_id !== workflowId
      || (revision !== null && parsed.data.revision !== revision)) return { ok: false, changed: false }
    return { ok: true, history: parsed.data }
  } catch { return { ok: false, changed: false } }
}

"use server"

import { revalidatePath } from "next/cache"
import { requireShop, requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import { draftSaveSchema } from "@/lib/control-center/drafts"

export async function savePolicyDraft(input: unknown): Promise<{ ok: true; revision: number } | { ok: false; error: string }> {
  const parsed = draftSaveSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: "Check the policy modes and scopes before saving." }
  await requireUser()
  const shop = await requireShop()
  if (shop.id !== parsed.data.shopId) return { ok: false, error: "This workspace is not available." }
  const db = await createClient()
  const { data, error } = await db.rpc("save_control_policy_draft", {
    p_shop: shop.id,
    p_expected_revision: parsed.data.expectedRevision,
    p_definition: parsed.data.definition,
  })
  if (error) return { ok: false, error: error.code === "PT409" ? "This draft changed in another session. Reload the page before saving." : "Draft was not saved. Reload and verify your owner access." }
  if (!Number.isSafeInteger(data) || data < 1) return { ok: false, error: "The save result could not be verified. Reload to check the draft revision before retrying." }
  revalidatePath("/control-center")
  return { ok: true, revision: data }
}

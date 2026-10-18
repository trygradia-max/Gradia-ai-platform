"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { requireShop, requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import { executeBrowserCheck } from "@/lib/super-agent/browser-job"
import { readBrowserCheck, saveBrowserCheck, type SavedBrowserCheck } from "@/lib/super-agent/browser-store"
import { ownerStillHasShop, readEmployeeDraft } from "@/lib/super-agent/research-store"
import { checkRateLimit } from "@/lib/rate-limit"
import type { SupabaseClient } from "@supabase/supabase-js"

function browserStore(db: SupabaseClient) {
  return {
    draft: (shopId: string, draftId: string) => readEmployeeDraft(db, shopId, draftId),
    check: (shopId: string, checkId: string) => readBrowserCheck(db, shopId, checkId),
    owns: (shopId: string, userId: string) => ownerStillHasShop(db, shopId, userId),
    save: (row: Parameters<typeof saveBrowserCheck>[1]) => saveBrowserCheck(db, row),
  }
}

/** A named provider is ignored. Its value is not stored, logged, or passed onward. */
function namedProviderIgnored(): boolean {
  const named = process.env.GRADIA_SUPER_AGENT_BROWSER_PROVIDER?.trim() ?? ""
  return named.length > 0 && named !== "none"
}

export async function checkCloudBrowser(input: unknown): Promise<{ ok: true; replayed: boolean; check: SavedBrowserCheck } | { ok: false; error: string }> {
  if (process.env.NEXT_PUBLIC_GRADIA_SUPER_AGENT !== "true" || process.env.GRADIA_SUPER_AGENT_BROWSER !== "true") {
    return { ok: false, error: "Cloud browser checks are not enabled here yet." }
  }
  const parsed = z.object({ id: z.uuid(), draftId: z.uuid() }).strict().safeParse(input)
  if (!parsed.success) return { ok: false, error: "This browser check could not be started." }
  const user = await requireUser()
  const shop = await requireShop()
  if (!(await checkRateLimit(shop.id, "agent_chat")).allowed) return { ok: false, error: "Please wait a moment before checking the browser again." }
  const db = await createClient()
  const result = await executeBrowserCheck({
    shopId: shop.id, userId: user.id, checkId: parsed.data.id, draftId: parsed.data.draftId, namedProviderIgnored: namedProviderIgnored(),
  }, browserStore(db))
  if (result.ok) revalidatePath("/employees")
  return result
}

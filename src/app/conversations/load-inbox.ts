import { threadListSchema } from "@/lib/whisper-inbox"
import type { TeamWorkspace } from "@/lib/team-permissions"
import { requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import type { z } from "zod"

export type InboxIndex = {
  shops: { id: string; name: string }[]
  shop: { id: string; name: string } | null
  page: number
  data: z.infer<typeof threadListSchema> | null
}

/**
 * List query for the conversation pane. Message history uses a separate
 * `page` parameter on the thread route; this offset is only the list window.
 */
export async function loadInboxIndex(
  shopParam?: string,
  pageParam?: string
): Promise<InboxIndex> {
  await requireUser()
  const db = await createClient()
  const n = Number(pageParam ?? 1)
  const page = Number.isSafeInteger(n) && n > 0 && n < 100000 ? n : 1
  const workspaces = await db.rpc("team_workspaces")
  if (workspaces.error) throw new Error("Workspace access could not be verified.")
  const shops = ((workspaces.data ?? []) as TeamWorkspace[]).map((shop) => ({
    id: shop.id,
    name: shop.name,
  }))
  const shop = shopParam ? (shops.find((item) => item.id === shopParam) ?? null) : (shops[0] ?? null)
  if (!shop) return { shops, shop: null, page, data: null }
  const r = await db.rpc("list_whisper_threads", {
    p_shop: shop.id,
    p_offset: (page - 1) * 20,
  })
  const parsed = r.error ? null : threadListSchema.safeParse(r.data)
  return {
    shops,
    shop,
    page,
    data: parsed?.success ? parsed.data : null,
  }
}

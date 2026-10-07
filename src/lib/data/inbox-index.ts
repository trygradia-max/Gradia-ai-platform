import { threadListSchema, type InboxThreadItem } from "@/lib/whisper-inbox"
import type { TeamWorkspace } from "@/lib/team-permissions"
import { listShopsForCurrentUser, requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import type { z } from "zod"

export type { InboxThreadItem }

export type InboxIndex = {
  shops: { id: string; name: string }[]
  shop: { id: string; name: string } | null
  page: number
  data: z.infer<typeof threadListSchema> | null
  loadFailed: boolean
}

export async function loadInboxIndex(
  shopParam?: string,
  pageParam?: string
): Promise<InboxIndex> {
  await requireUser()
  const db = await createClient()
  const n = Number(pageParam ?? 1)
  const page = Number.isSafeInteger(n) && n > 0 && n < 100000 ? n : 1
  const workspaces = await db.rpc("team_workspaces")
  if (workspaces.error) {
    const fallback = (await listShopsForCurrentUser()).map((s) => ({
      id: s.id,
      name: s.name,
    }))
    const shop = shopParam
      ? (fallback.find((s) => s.id === shopParam) ?? null)
      : (fallback[0] ?? null)
    return { shops: fallback, shop, page, data: null, loadFailed: true }
  }
  const shops = ((workspaces.data ?? []) as TeamWorkspace[]).map((s) => ({
    id: s.id,
    name: s.name,
  }))
  const shop = shopParam
    ? (shops.find((s) => s.id === shopParam) ?? null)
    : (shops[0] ?? null)
  if (!shop) {
    return { shops, shop: null, page, data: null, loadFailed: false }
  }
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
    loadFailed: !parsed?.success,
  }
}

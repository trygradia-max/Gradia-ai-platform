"use server"

import type { ChannelKey, ChannelReadiness } from "@/lib/channel-readiness"
import { loadChannelReadiness } from "@/lib/data/channel-readiness"
import { requireShop, requireUser } from "@/lib/shop"
import { createServiceClient } from "@/lib/supabase/service"

export type ChannelReadinessResult =
  | { ok: true; channels: Record<ChannelKey, ChannelReadiness> }
  | { ok: false; error: string }

/**
 * Calls, texting, email and Meta readiness for the signed-in owner's shop.
 * Owner only (requireShop resolves the shop the user owns); the service client
 * is used only after that, for the service-role Meta bindings, scoped to it.
 */
export async function getChannelReadiness(): Promise<ChannelReadinessResult> {
  await requireUser()
  const shop = await requireShop()
  return loadChannelReadiness(createServiceClient(), shop.id)
}

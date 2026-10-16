import type { SupabaseClient } from "@supabase/supabase-js"

import {
  channelReadiness,
  configuredChannels,
  type ChannelKey,
  type ChannelReadiness,
  type ReadinessShop,
} from "@/lib/channel-readiness"

const SHOP_FIELDS = [
  "twilio_phone_number", "gradia_number_e164", "a2p_status", "byo_sms_verified",
  "vapi_assistant_id", "vapi_phone_number_id", "voice_test_called_at", "voice_addon",
  "aurinko_access_token_enc", "aurinko_account_id", "aurinko_subscription_id",
].join(", ")

/**
 * Readiness for every channel of one shop. `service` must be a service-role
 * client: Meta page bindings are service-role only. Every read is scoped to
 * `shopId`; callers must have authorized the shop first. A failed read is
 * reported as an error, never as "not set up".
 */
export async function loadChannelReadiness(
  service: SupabaseClient,
  shopId: string,
  env: Record<string, string | undefined> = process.env
): Promise<{ ok: true; channels: Record<ChannelKey, ChannelReadiness> } | { ok: false; error: string }> {
  const [shop, bindings] = await Promise.all([
    service.from("shops").select(SHOP_FIELDS).eq("id", shopId).maybeSingle(),
    service.from("meta_lead_page_bindings").select("page_id", { count: "exact", head: true }).eq("shop_id", shopId),
  ])
  if (shop.error || !shop.data || bindings.error) {
    return { ok: false, error: "Couldn't check channel readiness. Try again." }
  }
  return {
    ok: true,
    channels: channelReadiness(shop.data as unknown as ReadinessShop, {
      metaPageBindings: bindings.count ?? 0,
      configured: configuredChannels(env),
    }),
  }
}

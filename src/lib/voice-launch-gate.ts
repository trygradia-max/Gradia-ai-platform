import type { ShopRow } from "@/lib/types/database"

export type LaunchGate = {
  ready: boolean
  missing: ("number" | "assistant" | "test_call")[]
}

/** Launch prerequisites (spec §2.4) — pure so the UI and the action share
 *  one truth. */
export function voiceLaunchGate(
  shop: Pick<
    ShopRow,
    "vapi_assistant_id" | "vapi_phone_number_id" | "voice_test_called_at"
  >
): LaunchGate {
  const missing: LaunchGate["missing"] = []
  if (!shop.vapi_phone_number_id) missing.push("number")
  if (!shop.vapi_assistant_id) missing.push("assistant")
  if (!shop.voice_test_called_at) missing.push("test_call")
  return { ready: missing.length === 0, missing }
}


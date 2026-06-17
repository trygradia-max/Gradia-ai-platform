/**
 * Event dispatch for custom agents.
 *
 * Scheduled agents fire on cron ticks. Event-driven agents fire when
 * something happens elsewhere in the code — a Stripe webhook resolves
 * a paid invoice, an approval lands a new booking, etc. The
 * publishers call `dispatchAgentEvent` with a typed event; this
 * module finds every enabled custom_agent whose recipe listens to
 * that event kind and runs it.
 *
 * Event handlers are best-effort and isolated — one crashing agent
 * can't poison another or the original flow. We catch + log; the
 * caller never awaits a meaningful error.
 *
 * `runtime.last_fired_at` doesn't apply for event-driven agents
 * (every matching event is its own decision point), so we don't stamp
 * it here.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import { createServiceClient } from "@/lib/supabase/service"
import type {
  AgentEventKind,
  CustomAgentRow,
  ShopRow,
} from "@/lib/types/database"

import { runEventRecipe } from "@/lib/agent-runtime"

// ---------- Event types ----------

export type AgentEvent =
  | {
      kind: "payment_received"
      shopId: string
      customerName: string | null
      customerEmail: string | null
      customerPhone: string | null
      customerId: string | null
      amountCents: number
      stripeInvoiceId: string | null
      paidAtIso: string
    }
  | {
      kind: "booking_approved"
      shopId: string
      customerName: string
      customerEmail: string | null
      customerPhone: string | null
      customerId: string | null
      serviceName: string | null
      isoStartTime: string
      timezone: string | null
      appointmentId: string | null
    }

/** Recipe ids that fire on each event kind. The runtime reads this
 *  to filter enabled agents. */
const RECIPES_FOR_EVENT: Record<AgentEventKind, string[]> = {
  payment_received: [
    "payment_received_thank_you_sms",
    // Post-job is the natural moment to ask for a review (NEXT-1).
    "review_request_sms",
    "review_request_email",
  ],
  booking_approved: ["booking_approved_prep_email"],
}

// ---------- Public dispatcher ----------

/**
 * Fan-out: find enabled custom_agents listening to the event's kind
 * and run their handlers. Always non-throwing — caller is doing real
 * work (executing an approval, processing a Stripe webhook) and
 * shouldn't ever fail because of a misbehaving custom agent.
 *
 * Passing a SupabaseClient is optional — webhook handlers already
 * have a service-role client; approval executors do too. If omitted,
 * we create one.
 */
export async function dispatchAgentEvent(
  event: AgentEvent,
  supabase?: SupabaseClient
): Promise<void> {
  const sb = supabase ?? createServiceClient()
  const recipeIds = RECIPES_FOR_EVENT[event.kind] ?? []
  if (recipeIds.length === 0) return

  try {
    const { data, error } = await sb
      .from("custom_agents")
      .select("*")
      .eq("enabled", true)
      .eq("shop_id", event.shopId)
      .in("config->recipe->>id", recipeIds)
    if (error) {
      console.error("[agent-events] lookup failed:", error)
      return
    }

    const agents = (data as CustomAgentRow[] | null) ?? []
    if (agents.length === 0) return

    // Load shop once for the whole fan-out.
    const { data: shopRow } = await sb
      .from("shops")
      .select("*")
      .eq("id", event.shopId)
      .maybeSingle()
    const shop = (shopRow as ShopRow | null) ?? null
    if (!shop) return

    for (const agent of agents) {
      try {
        await runEventRecipe(sb, shop, agent, event)
      } catch (err) {
        console.error(
          "[agent-events] agent handler crashed:",
          agent.id,
          err
        )
      }
    }
  } catch (err) {
    console.error("[agent-events] dispatch crashed:", err)
  }
}

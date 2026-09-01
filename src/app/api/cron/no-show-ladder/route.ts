/**
 * No-show ladder — confirm step (NEXT-2). Runs hourly (see vercel.json). Stages
 * a confirm-by-text for appointments inside the confirm window that haven't been
 * asked yet, mirroring the 24h reminder cron: stage a send_sms pending_action
 * (HITL — the owner approves before it goes out) and stamp
 * confirm_pending_action_id so the next tick skips it.
 *
 * The backfill nudge (the no-confirm path) is surfaced live on Home via the
 * co-owner card, not here. Calendar writes stay ALWAYS_HITL — this only ever
 * stages a message.
 *
 * Vercel cron auth: `Authorization: Bearer <CRON_SECRET>`. Fails closed.
 */

import {
  afterCatalogStage,
  catalogGateFor,
  renderTemplate,
  type AutomationConfig,
} from "@/lib/automations"
import { FEATURES } from "@/lib/features"
import {
  BACKFILL_CUTOFF_HOURS,
  CONFIRM_LEAD_HOURS,
  buildConfirmSms,
} from "@/lib/no-show-ladder"
import { sendSmsApprovalRequest } from "@/lib/slack"
import { createServiceClient } from "@/lib/supabase/service"
import type { AppointmentRow, CustomerRow, ShopRow } from "@/lib/types/database"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

const HOUR_MS = 60 * 60 * 1000

type JoinedAppointment = AppointmentRow & {
  shop: Pick<
    ShopRow,
    "id" | "name" | "owner_id" | "twilio_phone_number" | "plan" | "voice_addon" | "credit_period_start"
  > | null
  customer: Pick<CustomerRow, "id" | "name" | "phone"> | null
}

function unauthorized() {
  return new Response("Unauthorized", { status: 401 })
}

function formatWhen(iso: string, timezone: string | null): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: timezone ?? undefined,
    }).format(new Date(iso))
  } catch {
    return new Date(iso).toLocaleString()
  }
}

export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET?.trim()
  if (!expected) {
    console.error("[cron/no-show-ladder] CRON_SECRET not configured")
    return unauthorized()
  }
  if (request.headers.get("authorization") !== `Bearer ${expected}`) {
    return unauthorized()
  }
  if (!FEATURES.noShowLadder) {
    return Response.json({ ok: true, skipped: "feature disabled" })
  }

  const supabase = createServiceClient()

  // The confirm window: from the backfill cutoff out to the confirm lead time.
  const now = Date.now()
  const lower = new Date(now + BACKFILL_CUTOFF_HOURS * HOUR_MS).toISOString()
  const upper = new Date(now + CONFIRM_LEAD_HOURS * HOUR_MS).toISOString()

  const { data, error } = await supabase
    .from("appointments")
    .select(
      `
        *,
        shop:shops!inner(id, name, owner_id, twilio_phone_number, plan, voice_addon, credit_period_start),
        customer:customers(id, name, phone)
      `
    )
    .gte("scheduled_at", lower)
    .lt("scheduled_at", upper)
    .is("confirm_pending_action_id", null)
    .is("confirmed_at", null)

  if (error) {
    console.error("[cron/no-show-ladder] query failed:", error)
    return Response.json({ ok: false, error: error.message }, { status: 500 })
  }

  const appointments = (data as JoinedAppointment[] | null) ?? []
  let staged = 0
  let skipped = 0
  let failed = 0

  // C5 catalog gate (#5 appt_confirmation) — defaults are enabled +
  // approval, i.e. EXACTLY this cron's pre-catalog behavior.
  const gates = new Map<string, AutomationConfig>()
  for (const appt of appointments) {
    if (!appt.shop?.twilio_phone_number || !appt.customer?.phone) {
      skipped += 1
      continue
    }
    let gate = gates.get(appt.shop.id)
    if (!gate) {
      gate = await catalogGateFor(supabase, appt.shop.id, "appt_confirmation")
      gates.set(appt.shop.id, gate)
    }
    if (!gate.enabled) {
      skipped += 1
      continue
    }
    try {
      const ok = await stageConfirm(supabase, appt, gate)
      if (ok) staged += 1
      else skipped += 1
    } catch (err) {
      console.error("[cron/no-show-ladder] stage failed for", appt.id, err)
      failed += 1
    }
  }

  return Response.json({ ok: true, considered: appointments.length, staged, skipped, failed })
}

async function stageConfirm(
  supabase: ReturnType<typeof createServiceClient>,
  appt: JoinedAppointment,
  gate: AutomationConfig
): Promise<boolean> {
  if (!appt.shop || !appt.customer?.phone) return false

  // Owner template override wins; the empty default keeps the built-in
  // confirm copy with its Reply-YES contract (pre-catalog behavior).
  const body = gate.template.trim()
    ? renderTemplate(gate.template, {
        customer_name: (appt.customer.name ?? "there").split(/\s+/)[0],
        shop_name: appt.shop.name,
        when: formatWhen(appt.scheduled_at, appt.timezone),
        services: appt.service_name ?? "appointment",
      })
    : buildConfirmSms({
        shopName: appt.shop.name,
        customerName: appt.customer.name,
        service: appt.service_name,
        whenText: `on ${formatWhen(appt.scheduled_at, appt.timezone)}`,
      })
  const reason = appt.service_name?.trim()
    ? `Confirm · ${appt.service_name.trim()}`
    : "Confirm · appointment"

  const { data: pending, error: pendingErr } = await supabase
    .from("pending_actions")
    .insert({
      shop_id: appt.shop.id,
      action_type: "send_sms",
      payload: {
        to_phone: appt.customer.phone,
        body,
        customer_name: appt.customer.name,
        customer_id: appt.customer.id,
        reason,
        // A confirmation is transactional, not marketing.
        category: "transactional",
        source: "appointment_confirm",
        appointment_id: appt.id,
        iso_start_time: appt.scheduled_at,
      },
      requested_by: appt.shop.owner_id,
    })
    .select("id")
    .single()

  if (pendingErr || !pending) {
    console.error("[cron/no-show-ladder] pending insert failed:", pendingErr)
    return false
  }

  // Stamp BEFORE the Slack send so a hiccup can't double-stage next tick.
  await supabase
    .from("appointments")
    .update({ confirm_pending_action_id: pending.id })
    .eq("id", appt.id)
    .eq("shop_id", appt.shop.id)

  try {
    await sendSmsApprovalRequest({
      pendingActionId: pending.id,
      toPhone: appt.customer.phone,
      customerName: appt.customer.name,
      body,
      reason,
    })
  } catch (err) {
    console.error("[cron/no-show-ladder] Slack send failed:", err)
  }

  // C5: run history + (owner-opted) autopilot. Approval mode = no-op here.
  await afterCatalogStage(supabase, appt.shop, gate, pending.id, {
    customerId: appt.customer.id,
    triggerRef: `confirm:${appt.id}`,
  })

  return true
}

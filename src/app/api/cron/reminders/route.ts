/**
 * 24-hour appointment reminder cron.
 *
 * Runs hourly (see vercel.json). Each invocation:
 *   1. Finds appointments scheduled 23-25h from now where no reminder
 *      has been staged yet (reminder_pending_action_id IS NULL).
 *   2. Drafts a short reminder SMS via Claude.
 *   3. Stages it as a send_sms pending_action (HITL — operator
 *      approves before send, same as every other Gradia outbound).
 *   4. Stamps appointments.reminder_pending_action_id so the next
 *      cron run skips it.
 *
 * Vercel cron auth: every request includes `Authorization: Bearer
 * <CRON_SECRET>` when CRON_SECRET is set in env. We fail closed if
 * the header doesn't match.
 */

import {
  afterCatalogStage,
  catalogGateFor,
  renderTemplate,
  type AutomationConfig,
} from "@/lib/automations"
import { sendSmsApprovalRequest } from "@/lib/slack"
import { draftAppointmentReminderSms } from "@/lib/sms-drafter"
import { createServiceClient } from "@/lib/supabase/service"
import type { AppointmentRow, CustomerRow, ShopRow } from "@/lib/types/database"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

const WINDOW_LOWER_HOURS = 23
const WINDOW_UPPER_HOURS = 25

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

export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET?.trim()
  if (!expected) {
    console.error("[cron/reminders] CRON_SECRET not configured")
    return unauthorized()
  }
  const provided = request.headers.get("authorization")
  if (provided !== `Bearer ${expected}`) {
    return unauthorized()
  }

  const supabase = createServiceClient()

  const now = Date.now()
  const lower = new Date(now + WINDOW_LOWER_HOURS * 60 * 60 * 1000).toISOString()
  const upper = new Date(now + WINDOW_UPPER_HOURS * 60 * 60 * 1000).toISOString()

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
    .is("reminder_pending_action_id", null)

  if (error) {
    console.error("[cron/reminders] query failed:", error)
    return Response.json({ ok: false, error: error.message }, { status: 500 })
  }

  const appointments = (data as JoinedAppointment[] | null) ?? []

  let staged = 0
  let skipped = 0
  let failed = 0

  // C5 catalog gate (#6 appt_reminder) — cached per shop. Defaults are
  // enabled + approval, i.e. EXACTLY the pre-catalog behavior of this cron.
  const gates = new Map<string, AutomationConfig>()
  for (const appt of appointments) {
    if (!appt.shop?.twilio_phone_number) {
      skipped += 1
      continue
    }
    if (!appt.customer?.phone) {
      skipped += 1
      continue
    }
    let gate = gates.get(appt.shop.id)
    if (!gate) {
      gate = await catalogGateFor(supabase, appt.shop.id, "appt_reminder")
      gates.set(appt.shop.id, gate)
    }
    if (!gate.enabled) {
      skipped += 1
      continue
    }
    try {
      const ok = await stageReminder(supabase, appt, gate)
      if (ok) staged += 1
      else skipped += 1
    } catch (err) {
      console.error("[cron/reminders] stage failed for", appt.id, err)
      failed += 1
    }
  }

  return Response.json({
    ok: true,
    considered: appointments.length,
    staged,
    skipped,
    failed,
  })
}

async function stageReminder(
  supabase: ReturnType<typeof createServiceClient>,
  appt: JoinedAppointment,
  gate: AutomationConfig
): Promise<boolean> {
  if (!appt.shop || !appt.customer?.phone) return false

  // Owner template override wins; the empty default keeps the drafted copy
  // (pre-catalog behavior, unchanged).
  const draft = gate.template.trim()
    ? renderTemplate(gate.template, {
        customer_name: (appt.customer.name ?? "there").split(/\s+/)[0],
        shop_name: appt.shop.name,
        services: appt.service_name ?? "appointment",
      })
    : await draftAppointmentReminderSms({
        shopName: appt.shop.name,
        customerName: appt.customer.name ?? "there",
        service: appt.service_name,
        isoStartTime: appt.scheduled_at,
        timezone: appt.timezone,
        vehicle: null,
      })
  if (!draft) return false

  const reason = appt.service_name?.trim()
    ? `Reminder · ${appt.service_name.trim()} tomorrow`
    : "Reminder · appointment tomorrow"

  const { data: pending, error: pendingErr } = await supabase
    .from("pending_actions")
    .insert({
      shop_id: appt.shop.id,
      action_type: "send_sms",
      payload: {
        to_phone: appt.customer.phone,
        body: draft,
        customer_name: appt.customer.name,
        customer_id: appt.customer.id,
        reason,
        source: "appointment_reminder",
        appointment_id: appt.id,
        iso_start_time: appt.scheduled_at,
      },
      requested_by: appt.shop.owner_id,
    })
    .select("id")
    .single()

  if (pendingErr || !pending) {
    console.error(
      "[cron/reminders] pending_action insert failed:",
      pendingErr
    )
    return false
  }

  // Stamp the appointment so subsequent runs skip it. We do this
  // *before* the Slack send so a Slack hiccup can't cause duplicate
  // pending_actions on the next cron tick.
  await supabase
    .from("appointments")
    .update({ reminder_pending_action_id: pending.id })
    .eq("id", appt.id)

  try {
    await sendSmsApprovalRequest({
      pendingActionId: pending.id,
      toPhone: appt.customer.phone,
      customerName: appt.customer.name,
      body: draft,
      reason,
    })
  } catch (err) {
    console.error("[cron/reminders] Slack send failed:", err)
  }

  // C5: run history + (owner-opted) autopilot. Approval mode = no-op here.
  await afterCatalogStage(supabase, appt.shop, gate, pending.id, {
    customerId: appt.customer.id,
    triggerRef: `reminder:${appt.id}`,
  })

  return true
}

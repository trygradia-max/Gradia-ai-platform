/**
 * Calendar page data (CRM C4b). One week of jobs with the fields the grid,
 * the day list, and the job card need. Pre-C1 rows surface with derived
 * status (confirmed_at → confirmed, else booked) so the page works before
 * the founder applies the migration.
 */

import { createClient } from "@/lib/supabase/server"
import { requireShop } from "@/lib/shop"
import { describeVehicle, vehiclesByCustomerIds } from "@/lib/vehicles"
import type {
  AppointmentRow,
  JobPaymentStatus,
  JobStatus,
  ShopRow,
} from "@/lib/types/database"

export type CalendarJob = {
  id: string
  scheduledAt: string
  durationMinutes: number
  status: JobStatus
  paymentStatus: JobPaymentStatus
  serviceName: string | null
  customerId: string | null
  customerName: string | null
  customerPhone: string | null
  vehicle: string | null
  locationType: "shop" | "mobile"
  address: Record<string, unknown> | null
  travelFeeCents: number | null
  accessNotes: Record<string, unknown> | null
  weatherFlag: boolean
  bay: string | null
  keyTag: string | null
  internalNote: string | null
  isBlock: boolean
  confirmed: boolean
}

export type CalendarWeek = {
  weekStartIso: string
  jobs: CalendarJob[]
  /** Working-hours capacity per day, minutes (code default, owner-tunable
   *  via shops.settings.calendar.working_hours_per_day). */
  dailyCapacityMinutes: number
}

const DEFAULT_WORKING_HOURS_PER_DAY = 8

export function startOfWeek(d: Date): Date {
  const out = new Date(d)
  out.setHours(0, 0, 0, 0)
  const day = out.getDay() // 0 Sun … 6 Sat
  const diff = day === 0 ? -6 : 1 - day // weeks start Monday
  out.setDate(out.getDate() + diff)
  return out
}

export async function loadCalendarWeek(weekParam?: string): Promise<CalendarWeek> {
  const shop = await requireShop()
  const supabase = await createClient()

  const anchor = weekParam ? new Date(weekParam) : new Date()
  const weekStart = startOfWeek(Number.isNaN(anchor.getTime()) ? new Date() : anchor)
  const weekEnd = new Date(weekStart.getTime() + 7 * 86_400_000)

  const { data, error } = await supabase
    .from("appointments")
    .select("*, customer:customers(id, name, phone)")
    .eq("shop_id", shop.id)
    .gte("scheduled_at", weekStart.toISOString())
    .lt("scheduled_at", weekEnd.toISOString())
    .order("scheduled_at", { ascending: true })
    .limit(400)
  if (error) throw new Error(error.message)

  type Row = AppointmentRow & {
    customer: { id: string; name: string | null; phone: string | null } | null
  }
  const rows = (data as Row[] | null) ?? []

  const customerIds = rows
    .map((r) => r.customer_id)
    .filter((id): id is string => Boolean(id))
  const vehicles = await vehiclesByCustomerIds(supabase, shop.id, customerIds)

  const { data: shopRow } = await supabase
    .from("shops")
    .select("settings")
    .eq("id", shop.id)
    .maybeSingle()
  const settings = ((shopRow as Pick<ShopRow, "settings"> | null)?.settings ??
    {}) as Record<string, unknown>
  const calendarSettings = (settings.calendar ?? {}) as Record<string, unknown>
  const workingHours =
    typeof calendarSettings.working_hours_per_day === "number" &&
    calendarSettings.working_hours_per_day > 0
      ? calendarSettings.working_hours_per_day
      : DEFAULT_WORKING_HOURS_PER_DAY

  const jobs: CalendarJob[] = rows.map((r) => ({
    id: r.id,
    scheduledAt: r.scheduled_at,
    durationMinutes: r.duration_minutes ?? 90,
    status: r.status ?? (r.confirmed_at ? "confirmed" : "booked"),
    paymentStatus: r.payment_status ?? "unpaid",
    serviceName: r.service_name,
    customerId: r.customer_id,
    customerName: r.customer?.name ?? null,
    customerPhone: r.customer?.phone ?? null,
    vehicle: r.customer_id
      ? describeVehicle(vehicles.get(r.customer_id)?.[0])
      : null,
    locationType: r.location_type ?? "shop",
    address: r.address ?? null,
    travelFeeCents: r.travel_fee_cents ?? null,
    accessNotes: r.access_notes ?? null,
    weatherFlag: r.weather_flag ?? false,
    bay: typeof r.access_notes?.bay === "string" ? (r.access_notes.bay as string) : null,
    keyTag: r.key_tag ?? null,
    internalNote: r.internal_note ?? null,
    isBlock: r.internal_note === "[block-time]",
    confirmed: Boolean(r.confirmed_at),
  }))

  return {
    weekStartIso: weekStart.toISOString(),
    jobs,
    dailyCapacityMinutes: workingHours * 60,
  }
}

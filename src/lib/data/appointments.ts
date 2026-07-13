import { createClient } from "@/lib/supabase/server"
import { getOptionalShop } from "@/lib/shop"

/** One row of the Home "Booked" module (schedule's approved home). */
export type TodaysAppointment = {
  id: string
  scheduledAt: string
  serviceName: string | null
  durationMinutes: number | null
  timezone: string | null
  customerName: string | null
  confirmed: boolean
}

/** Today's appointments (local day window), soonest first. */
export async function listTodaysAppointments(): Promise<TodaysAppointment[]> {
  const shop = await getOptionalShop()
  if (!shop) return []
  const supabase = await createClient()

  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000)

  const { data, error } = await supabase
    .from("appointments")
    .select(
      "id, scheduled_at, service_name, duration_minutes, timezone, confirmed_at, customer:customers(name)"
    )
    .eq("shop_id", shop.id)
    .gte("scheduled_at", start.toISOString())
    .lt("scheduled_at", end.toISOString())
    .order("scheduled_at", { ascending: true })
    .limit(8)

  if (error) {
    console.error("[data/appointments] today query failed:", error)
    return []
  }

  type Row = {
    id: string
    scheduled_at: string
    service_name: string | null
    duration_minutes: number | null
    timezone: string | null
    confirmed_at: string | null
    customer: { name: string | null } | null
  }
  return ((data as unknown as Row[] | null) ?? []).map((r) => ({
    id: r.id,
    scheduledAt: r.scheduled_at,
    serviceName: r.service_name,
    durationMinutes: r.duration_minutes,
    timezone: r.timezone,
    customerName: r.customer?.name ?? null,
    confirmed: Boolean(r.confirmed_at),
  }))
}

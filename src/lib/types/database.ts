export type LeadStatus = "new" | "quoted" | "booked"

export type ShopRow = {
  id: string
  name: string
  owner_id: string
  settings: Record<string, unknown>
  created_at: string
  updated_at: string
}

export type LeadRow = {
  id: string
  shop_id: string
  customer_name: string
  phone: string
  car_info: string | null
  pin_notes: string | null
  status: LeadStatus
  created_at: string
  updated_at: string
}

export type ServiceRow = {
  id: string
  shop_id: string
  name: string
  description: string | null
  price_cents: number
  duration_minutes: number
  created_at: string
  updated_at: string
}

export type AppointmentRow = {
  id: string
  shop_id: string
  lead_id: string | null
  scheduled_at: string
  created_at: string
  updated_at: string
}

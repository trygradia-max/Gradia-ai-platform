/**
 * CRM provider seam. The single boundary every approval path crosses to
 * push leads/bookings into whatever CRM(s) a shop has connected — today
 * Jobber and Housecall Pro. Vendor modules (jobber-push.ts,
 * housecallpro-push.ts) never leak past this file; approvals.ts and any
 * future caller talk only to `pushLeadToCrm` / `pushBookingToCrm`.
 *
 * Adding a CRM = implement its `<vendor>-push.ts` (mirroring the two
 * existing ones) and add one entry to PROVIDERS below. No call-site
 * changes.
 *
 * Semantics: a shop may connect more than one CRM; we push to EVERY
 * connected provider, best-effort and independently. A vendor that
 * isn't connected for a shop short-circuits inside its own push module
 * (loadShopIfConnected → return), so calling all providers is cheap and
 * safe. One vendor failing never affects another or the approval.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import {
  pushBookingToHousecallPro,
  pushLeadToHousecallPro,
} from "@/lib/housecallpro-push"
import { pushBookingToJobber, pushLeadToJobber } from "@/lib/jobber-push"

export type CrmLeadPush = {
  supabase: SupabaseClient
  shopId: string
  customerId: string | null
  customerName: string
  phone: string | null
  email?: string | null
}

export type CrmBookingPush = {
  supabase: SupabaseClient
  shopId: string
  appointmentId: string
  customerId: string | null
  customerName: string
  phone: string | null
  email?: string | null
  service: string | null
  isoStartTime: string
  carInfo: string | null
}

type CrmProvider = {
  name: string
  pushLead: (input: CrmLeadPush) => Promise<void>
  pushBooking: (input: CrmBookingPush) => Promise<void>
}

const PROVIDERS: CrmProvider[] = [
  {
    name: "jobber",
    pushLead: pushLeadToJobber,
    pushBooking: pushBookingToJobber,
  },
  {
    name: "housecallpro",
    pushLead: pushLeadToHousecallPro,
    pushBooking: pushBookingToHousecallPro,
  },
]

/**
 * Find-or-create the customer in every connected CRM after a lead is
 * approved. Best-effort per provider; failures are logged, never thrown.
 */
export async function pushLeadToCrm(input: CrmLeadPush): Promise<void> {
  await Promise.all(
    PROVIDERS.map(async (p) => {
      try {
        await p.pushLead(input)
      } catch (err) {
        console.warn(`[crm:${p.name}] lead push failed:`, err)
      }
    })
  )
}

/**
 * Mirror an approved booking into every connected CRM (customer +
 * job/request). Best-effort per provider; failures are logged, never
 * thrown.
 */
export async function pushBookingToCrm(input: CrmBookingPush): Promise<void> {
  await Promise.all(
    PROVIDERS.map(async (p) => {
      try {
        await p.pushBooking(input)
      } catch (err) {
        console.warn(`[crm:${p.name}] booking push failed:`, err)
      }
    })
  )
}

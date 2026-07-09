/**
 * Service-menu editing (CRM C3a) — the pure layer between the Settings
 * editor form and the services table. Converts owner-typed dollars/minutes
 * into the column patches the action applies, split into:
 *   core     — pre-C1 columns (always safe to write)
 *   extended — C1 size-class pricing columns (best-effort write until the
 *              founder applies the migration; tolerance pattern)
 *
 * The menu this edits is the shop's single pricing source of truth: CRM
 * quotes, the voice receptionist, and Whisper grounding all resolve through
 * lib/service-pricing.ts, so a change here changes every quote surface at
 * once (and nothing else may hardcode a price).
 */

import type {
  ConditionMultiplier,
  VehicleSizeClass,
} from "@/lib/types/database"
import { VEHICLE_SIZE_CLASSES } from "@/lib/service-pricing"

export const SIZE_CLASS_LABELS: Record<VehicleSizeClass, string> = {
  sedan: "Sedan",
  coupe: "Coupe",
  truck_suv: "Truck / SUV",
  xl_van: "XL van",
  exotic: "Exotic",
  rv: "RV",
  boat: "Boat",
  motorcycle: "Motorcycle",
}

export type ServiceMenuInput = {
  name: string
  description?: string | null
  /** Fallback price in dollars — the locked resolution fallback. */
  priceDollars: number
  durationMinutes: number
  category?: string | null
  /** Per-size prices in dollars; missing/blank sizes fall back. */
  priceBySizeDollars?: Partial<Record<VehicleSizeClass, number | null>>
  /** Per-size durations in minutes; missing sizes fall back. */
  durationBySizeMinutes?: Partial<Record<VehicleSizeClass, number | null>>
  /** Condition multipliers, label + factor; keys derive from labels. */
  multipliers?: { label: string; multiplier: number }[]
  isAddon?: boolean
  addonEligible?: boolean
  mobileEligible?: boolean
  active?: boolean
}

export type ServicePatches = {
  core: Record<string, unknown>
  extended: Record<string, unknown>
}

/** "Heavy soiling / pet hair" → "heavy_soiling_pet_hair" */
export function multiplierKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
}

function sizeMapCents(
  dollars: Partial<Record<VehicleSizeClass, number | null>> | undefined
): Record<string, number> | null {
  if (!dollars) return null
  const out: Record<string, number> = {}
  for (const size of VEHICLE_SIZE_CLASSES) {
    const v = dollars[size]
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      out[size] = Math.round(v * 100)
    }
  }
  return Object.keys(out).length > 0 ? out : null
}

function sizeMapMinutes(
  minutes: Partial<Record<VehicleSizeClass, number | null>> | undefined
): Record<string, number> | null {
  if (!minutes) return null
  const out: Record<string, number> = {}
  for (const size of VEHICLE_SIZE_CLASSES) {
    const v = minutes[size]
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      out[size] = Math.round(v)
    }
  }
  return Object.keys(out).length > 0 ? out : null
}

function cleanMultipliers(
  input: { label: string; multiplier: number }[] | undefined
): ConditionMultiplier[] | null {
  if (!input) return null
  const out: ConditionMultiplier[] = []
  for (const m of input) {
    const label = m.label.trim()
    const key = multiplierKey(label)
    if (!key) continue
    if (!Number.isFinite(m.multiplier) || m.multiplier <= 0 || m.multiplier > 10) {
      continue
    }
    out.push({ key, label, multiplier: m.multiplier })
  }
  return out.length > 0 ? out : null
}

/** Pure: form input → the two column patches the action applies. */
export function buildServicePatches(input: ServiceMenuInput): ServicePatches {
  return {
    core: {
      name: input.name.trim(),
      description: input.description?.trim() || null,
      price_cents: Math.round(input.priceDollars * 100),
      duration_minutes: Math.max(1, Math.round(input.durationMinutes)),
    },
    extended: {
      category: input.category?.trim() || null,
      base_price_by_size: sizeMapCents(input.priceBySizeDollars),
      duration_by_size: sizeMapMinutes(input.durationBySizeMinutes),
      condition_multipliers: cleanMultipliers(input.multipliers),
      is_addon: input.isAddon ?? false,
      addon_eligible: input.addonEligible ?? true,
      mobile_eligible: input.mobileEligible ?? true,
      active: input.active ?? true,
    },
  }
}

/**
 * The detailer starter menu the Settings editor offers as a one-tap prefill.
 * (Spec §C3 says reuse the onboarding wizard's template — the wizard never
 * actually shipped one, so this is now THE template; the wizard can reuse it
 * later.) Prices are deliberately mid-market defaults the owner edits.
 */
export const DETAILER_TEMPLATE_MENU: ServiceMenuInput[] = [
  {
    name: "Express Wash",
    description: "Exterior hand wash, wheels, and windows.",
    priceDollars: 49,
    durationMinutes: 45,
    category: "wash",
    priceBySizeDollars: { sedan: 49, coupe: 49, truck_suv: 59, xl_van: 69 },
  },
  {
    name: "Interior Detail",
    description: "Full interior — vacuum, steam, panels, glass.",
    priceDollars: 179,
    durationMinutes: 150,
    category: "interior",
    priceBySizeDollars: { sedan: 179, coupe: 169, truck_suv: 219, xl_van: 259 },
    durationBySizeMinutes: { sedan: 150, truck_suv: 180, xl_van: 210 },
    multipliers: [
      { label: "Heavy soiling", multiplier: 1.25 },
      { label: "Pet hair", multiplier: 1.15 },
    ],
  },
  {
    name: "Full Detail",
    description: "Interior detail plus exterior wash, clay, and sealant.",
    priceDollars: 299,
    durationMinutes: 240,
    category: "detail",
    priceBySizeDollars: { sedan: 299, coupe: 289, truck_suv: 359, xl_van: 419 },
    durationBySizeMinutes: { sedan: 240, truck_suv: 300 },
    multipliers: [{ label: "Heavy soiling", multiplier: 1.2 }],
  },
  {
    name: "Paint Correction",
    description: "Machine polish to remove swirls and light scratches.",
    priceDollars: 499,
    durationMinutes: 360,
    category: "correction",
    priceBySizeDollars: { sedan: 499, coupe: 479, truck_suv: 599 },
  },
  {
    name: "Ceramic Coating",
    description: "Multi-year ceramic protection over corrected paint.",
    priceDollars: 999,
    durationMinutes: 480,
    category: "protection",
    priceBySizeDollars: { sedan: 999, coupe: 949, truck_suv: 1199, xl_van: 1399 },
    durationBySizeMinutes: { sedan: 480, truck_suv: 540 },
  },
  {
    name: "Engine Bay Cleaning",
    description: "Degrease and dress the engine bay.",
    priceDollars: 79,
    durationMinutes: 45,
    category: "addon",
    isAddon: true,
  },
  {
    name: "Headlight Restoration",
    description: "Sand, polish, and seal cloudy headlights.",
    priceDollars: 89,
    durationMinutes: 60,
    category: "addon",
    isAddon: true,
  },
]

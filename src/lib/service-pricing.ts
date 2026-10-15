/**
 * Service pricing resolution — the ONE module that turns a service row
 * (plus an optional vehicle size class) into a price and duration
 * (GRADIA_CRM_FOUNDATION_SPEC §C1.6, locked). Voice quotes (vapi-tools /
 * vapi-prompt), CRM quotes, and Whisper drafting grounding all read through
 * here, so a voice quote and a CRM quote can never disagree on a number.
 *
 * Resolution rule: size-class price if present and valid, else `price_cents`.
 * Same shape for duration. The jsonb maps are owner-edited config — treat
 * every value as untrusted and fall back rather than throw.
 *
 * Distinct from lib/pricing.ts, which is Gradia's own metering/markup
 * pricing (credits). This module is the SHOP's service menu.
 */

import type {
  ConditionMultiplier,
  ServiceRow,
  VehicleSizeClass,
} from "@/lib/types/database"

export const VEHICLE_SIZE_CLASSES: readonly VehicleSizeClass[] = [
  "sedan",
  "coupe",
  "truck_suv",
  "xl_van",
  "exotic",
  "rv",
  "boat",
  "motorcycle",
] as const

/** The subset of a service row price resolution needs. */
export type ServicePriceFields = Pick<ServiceRow, "price_cents"> &
  Partial<Pick<ServiceRow, "base_price_by_size" | "condition_multipliers">>

/** The subset of a service row duration resolution needs. */
export type ServiceDurationFields = Pick<ServiceRow, "duration_minutes"> &
  Partial<Pick<ServiceRow, "duration_by_size">>

/** A positive finite number out of untrusted jsonb, else null. */
function positiveNumber(raw: unknown): number | null {
  const n =
    typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null
  return Math.round(n)
}

/** Read one size-class entry from an owner-edited jsonb map. */
function readSizeMap(
  map: unknown,
  size: VehicleSizeClass | null | undefined
): number | null {
  if (!size || !map || typeof map !== "object" || Array.isArray(map)) {
    return null
  }
  return positiveNumber((map as Record<string, unknown>)[size])
}

/** Every valid value in a size map, for spread/range computation. */
function validSizeValues(map: unknown): number[] {
  if (!map || typeof map !== "object" || Array.isArray(map)) return []
  const out: number[] = []
  for (const size of VEHICLE_SIZE_CLASSES) {
    const v = positiveNumber((map as Record<string, unknown>)[size])
    if (v != null) out.push(v)
  }
  return out
}

/**
 * The locked resolution rule: size-class price when the map has a valid
 * entry for the vehicle's size, otherwise `price_cents`.
 */
export function resolvePriceCents(
  service: ServicePriceFields,
  sizeClass?: VehicleSizeClass | null
): number {
  return (
    readSizeMap(service.base_price_by_size, sizeClass) ?? service.price_cents
  )
}

/** Duration follows the same rule with `duration_minutes` as fallback. */
export function resolveDurationMinutes(
  service: ServiceDurationFields,
  sizeClass?: VehicleSizeClass | null
): number {
  return (
    readSizeMap(service.duration_by_size, sizeClass) ??
    service.duration_minutes
  )
}

/**
 * Duration spread across configured size classes — the DURATION twin of
 * `priceSpread`, for surfaces that must say how long a job takes before the
 * vehicle is known. Null when the service has no valid size-class durations
 * (flat duration); low === high when they don't vary.
 *
 * Why this exists: `resolveDurationMinutes(service)` called with NO size
 * class silently returns the flat `duration_minutes`, so a shop that
 * configured "sedan 4h, truck/SUV 6h" had every voice and drafting surface
 * confidently state the sedan number to a truck owner. Price never had this
 * bug because `describePrice` already fell back to a spread. Callers that
 * cannot know the size must render a range, never a single number.
 */
export function durationSpread(
  service: ServiceDurationFields
): { low: number; high: number } | null {
  const values = validSizeValues(service.duration_by_size)
  if (values.length === 0) return null
  return { low: Math.min(...values), high: Math.max(...values) }
}

/**
 * One compact duration phrase for text surfaces (drafter grounding, menus):
 * exact ("90 min") when the size class is known or the duration is flat, a
 * range ("90–150 min depending on vehicle size") when size-class durations
 * vary and the vehicle is unknown. Voice surfaces use `durationSpread` with
 * their own TTS formatter instead — same rule, spoken phrasing.
 */
export function describeDuration(
  service: ServiceDurationFields,
  sizeClass?: VehicleSizeClass | null
): string {
  if (sizeClass && readSizeMap(service.duration_by_size, sizeClass) != null) {
    return `${resolveDurationMinutes(service, sizeClass)} min`
  }
  const spread = durationSpread(service)
  if (spread && spread.low !== spread.high) {
    return `${spread.low}–${spread.high} min depending on vehicle size`
  }
  if (spread) return `${spread.low} min`
  return `${service.duration_minutes} min`
}

/**
 * Price spread across configured size classes — what to quote when the
 * vehicle's size isn't known yet. Null when the service has no valid
 * size-class prices (flat pricing); low === high when they don't vary.
 */
export function priceSpread(
  service: ServicePriceFields
): { low: number; high: number } | null {
  const values = validSizeValues(service.base_price_by_size)
  if (values.length === 0) return null
  return { low: Math.min(...values), high: Math.max(...values) }
}

/**
 * Apply the service's condition multipliers (by key) to a resolved price.
 * Unknown keys and malformed entries are skipped; result is rounded once at
 * the end so chained multipliers can't drift by repeated rounding.
 */
export function applyConditionMultipliers(
  cents: number,
  service: ServicePriceFields,
  keys: string[]
): number {
  const entries = Array.isArray(service.condition_multipliers)
    ? service.condition_multipliers
    : []
  let result = cents
  for (const key of keys) {
    const entry = entries.find(
      (m): m is ConditionMultiplier =>
        Boolean(m) &&
        typeof m === "object" &&
        (m as ConditionMultiplier).key === key
    )
    const mult = entry?.multiplier
    if (typeof mult !== "number" || !Number.isFinite(mult) || mult <= 0) {
      continue
    }
    result *= mult
  }
  return Math.round(result)
}

/** "$150" / "$149.50" — shared so every surface prints money the same way. */
export function formatPriceUsd(cents: number): string {
  const dollars = cents / 100
  return dollars % 1 === 0 ? `$${dollars}` : `$${dollars.toFixed(2)}`
}

/**
 * One price phrase for a service. Exact ("$150") when the size class is
 * known or pricing is flat; a spread ("$150 to $250 depending on vehicle
 * size") when size-class prices vary and the vehicle is unknown. Written to
 * read well in both TTS and text.
 */
export function describePrice(
  service: ServicePriceFields,
  sizeClass?: VehicleSizeClass | null
): string {
  if (sizeClass && readSizeMap(service.base_price_by_size, sizeClass) != null) {
    return formatPriceUsd(resolvePriceCents(service, sizeClass))
  }
  const spread = priceSpread(service)
  if (spread && spread.low !== spread.high) {
    return `${formatPriceUsd(spread.low)} to ${formatPriceUsd(spread.high)} depending on vehicle size`
  }
  if (spread) return formatPriceUsd(spread.low)
  return formatPriceUsd(service.price_cents)
}

/** Deterministic, locale-pinned formatting (same output on server and client; no hydration drift). */
const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 })
const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })

export const formatNumber = (n: number): string => NUMBER.format(n)

export function formatMinutes(total: number): string {
  if (total >= 1440 && total % 1440 === 0) {
    const days = total / 1440
    return `${formatNumber(days)} ${days === 1 ? "day" : "days"}`
  }
  if (total < 60) return `${formatNumber(total)} min`
  const hours = Math.floor(total / 60)
  const rest = total % 60
  return rest ? `${hours} hr ${formatNumber(rest)} min` : `${hours} hr`
}

const SUFFIX: Record<string, string> = {
  count: "",
  count_per_month: " a month",
  count_per_week: " a week",
  hours_per_week: " hours a week",
  days_per_week: " days a week",
}

/** One value with its unit, in words an owner would say. */
export function formatUnitValue(value: number, unit: string | null): string {
  switch (unit) {
    case "percent":
      return `${formatNumber(value)}%`
    case "minutes":
      return formatMinutes(value)
    case "usd":
      return `$${formatNumber(value)}`
    case "hours_per_week":
      return `${formatNumber(value)} ${value === 1 ? "hour" : "hours"} a week`
    case "days_per_week":
      return `${formatNumber(value)} ${value === 1 ? "day" : "days"} a week`
    default:
      return `${formatNumber(value)}${SUFFIX[unit ?? ""] ?? ""}`
  }
}

/** An owner-given range, kept as a range. Never collapsed to a midpoint. */
export function formatRange(min: number, max: number, unit: string | null): string {
  if (unit === "percent" || unit === "minutes" || unit === "usd") {
    return `${formatUnitValue(min, unit)} to ${formatUnitValue(max, unit)}`
  }
  const suffix = SUFFIX[unit ?? ""] ?? ""
  return `${formatNumber(min)} to ${formatNumber(max)}${suffix}`
}

/** `YYYY-MM-DD` or an ISO timestamp, shown as a UTC calendar date. */
export function formatDate(value: string): string {
  const ms = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value)
  return Number.isFinite(ms) ? DATE.format(new Date(ms)) : value
}

export function formatDateRange(start: string, end: string): string {
  const a = formatDate(start)
  const b = formatDate(end)
  return a === b ? a : `${a} to ${b}`
}

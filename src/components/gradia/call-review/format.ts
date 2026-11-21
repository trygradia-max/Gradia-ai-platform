/** Deterministic, timezone-explicit formatting so a server render and a client render always agree. */
const FMT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" })
const TIME = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: "UTC" })

export function fmtUtc(iso: string | null | undefined): string {
  if (!iso) return "time unavailable"
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? "time unavailable" : `${FMT.format(d)} UTC`
}

export function fmtClock(iso: string | null | undefined): string {
  if (!iso) return "time unavailable"
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? "time unavailable" : `${TIME.format(d)} UTC`
}

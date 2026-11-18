const DAY = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** Days of recent history an owner's answers describe ("a normal month over the last three months"). */
export const REPORTING_PERIOD_DAYS = 90

/**
 * The window the owner's estimates describe: {@link REPORTING_PERIOD_DAYS} calendar days ending
 * yesterday (UTC). The database refuses an end date after its own current date, so ending yesterday
 * keeps clock skew and time zones from ever producing a future period.
 */
export function defaultReportingPeriod(now: Date): { start: string; end: string } {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - DAY
  return { start: iso(end - (REPORTING_PERIOD_DAYS - 1) * DAY), end: iso(end) }
}

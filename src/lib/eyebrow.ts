/**
 * Server-side eyebrow string builder for dashboard hero sections.
 * Lives on the server so SSR + first paint agree exactly — no
 * client-side useEffect to flip the value after hydration.
 *
 * Greeting tier follows the operator's local server time when
 * possible. For Vercel server-rendering this is UTC by default;
 * the rougher "Today" eyebrow is fine when timezone is uncertain
 * because the shop's actual TZ lives in the future Shop settings.
 */

const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "long" })
const DATE = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
})

function timeOfDayGreeting(hour: number): string {
  if (hour < 5) return "Late shift"
  if (hour < 12) return "Good morning"
  if (hour < 17) return "Good afternoon"
  if (hour < 21) return "Good evening"
  return "Late shift"
}

export function dashboardEyebrow(now: Date = new Date()): string {
  return `${timeOfDayGreeting(now.getHours())} · ${WEEKDAY.format(now)} ${DATE.format(now)}`
}

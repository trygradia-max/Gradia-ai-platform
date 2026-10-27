/**
 * First-run welcome after setup. Short, skippable, and honest: it names
 * the shop and lets the owner into the app. It does not claim channels
 * are live or that "everything is connected."
 */

export const WELCOME_QUERY = "welcome"
export const WELCOME_DASHBOARD_HREF = "/dashboard?welcome=1"

export function isWelcomeRequest(value: string | string[] | undefined): boolean {
  const raw = Array.isArray(value) ? value[0] : value
  return raw === "1"
}

export function welcomeHeading(shopName: string): string {
  const name = shopName.trim() || "your shop"
  return `Welcome to Gradia, ${name}.`
}

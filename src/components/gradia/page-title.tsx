"use client"

import { usePathname } from "next/navigation"

/** Topbar page title (spec §3): the current destination's name, derived
 *  client-side so the server layout stays static across navigations. */
const TITLES: [prefix: string, title: string][] = [
  ["/dashboard", "Home"],
  ["/approvals", "Approvals"],
  ["/activity", "Activity"],
  ["/calls", "Call record"],
  ["/conversations", "Conversations"],
  ["/customers/recovery", "Customers · Import"],
  ["/customers", "Customers"],
  ["/receptionist/build", "Receptionist · Build"],
  ["/receptionist", "Receptionist"],
  ["/calendar", "Calendar"],
  ["/settings", "Settings"],
]

export function PageTitle() {
  const pathname = usePathname()
  const match = TITLES.find(([prefix]) => pathname.startsWith(prefix))
  return (
    <span className="text-sm font-medium text-foreground">
      {match ? match[1] : "Gradia"}
    </span>
  )
}

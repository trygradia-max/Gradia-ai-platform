import { redirect } from "next/navigation"

/** Schedule folded into Calendar (CRM C4b, approved 5-page IA) — jobs are
 *  the schedule now; the old Aurinko-events list is superseded. */
export default function LegacySchedulePage() {
  redirect("/calendar")
}

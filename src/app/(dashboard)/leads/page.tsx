import { redirect } from "next/navigation"

/** Leads folded into Customers (redesign spec §8-A4) — a lead is a
 *  customer state, not a separate place. */
export default function LegacyLeadsPage() {
  redirect("/customers")
}

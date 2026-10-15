import { redirect } from "next/navigation"

/** Leads are pipeline cards, not a separate list. */
export default function LegacyLeadsPage() {
  redirect("/pipeline")
}

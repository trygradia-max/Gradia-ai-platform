import { redirect } from "next/navigation"

/** Consolidated into Receptionist (redesign spec §8-A4). Kept as a
 *  redirect so old links/bookmarks never dead-end. */
export default function LegacyAgentsPage() {
  redirect("/receptionist")
}

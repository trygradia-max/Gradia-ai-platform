import { redirect } from "next/navigation"

/** Activity is a section of Chief of Staff (B-14), not its own destination. */
export default function ActivityIndexPage() {
  redirect("/dashboard#activity")
}

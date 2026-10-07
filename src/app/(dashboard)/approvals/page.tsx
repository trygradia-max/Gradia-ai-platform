import { redirect } from "next/navigation"

/** Approvals are a section of Chief of Staff (B-14), not their own destination.
 *  /approvals/[id] stays a direct link for a single card. */
export default function ApprovalsIndexPage() {
  redirect("/dashboard#needs-you")
}

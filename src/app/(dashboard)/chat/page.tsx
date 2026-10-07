import { redirect } from "next/navigation"

/** Ask Gradia is the ⌘K command bar on every screen, not a page. */
export default function LegacyChatPage() {
  redirect("/conversations")
}

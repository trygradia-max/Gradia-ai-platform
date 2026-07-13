import { redirect } from "next/navigation"

/** Consolidated into Receptionist (redesign spec §8-A4). The Gradia
 *  Agent composer itself lives in the ⌘K command bar / mobile composer
 *  on every screen — this full-page variant folded into the shell. */
export default function LegacyAgentPage() {
  redirect("/receptionist")
}

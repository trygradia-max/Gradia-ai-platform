import { redirect } from "next/navigation"

/** Consolidated into Receptionist (redesign spec §8-A4). */
export default function LegacyAgentBuildPage() {
  redirect("/receptionist/build")
}

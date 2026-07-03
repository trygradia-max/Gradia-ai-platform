import { redirect } from "next/navigation"

/** Recovery is a flow inside customer context now (redesign spec §8-A4). */
export default function LegacyRecoveryPage() {
  redirect("/customers/recovery")
}

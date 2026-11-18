import { getBaselineStartingPoint } from "@/app/actions/onboarding-baseline"
import { SectionHeader } from "@/components/gradia/section-header"
import { StartingPointExperience } from "@/components/gradia/starting-point/starting-point-experience"
import { STRINGS } from "@/lib/strings"

export const dynamic = "force-dynamic"

const T = STRINGS.pages.startingPoint

/**
 * The canonical Starting point: the report, and the update flow (`?revise=1`). Everything is read through
 * the session-derived action, so the shop and role come from the signed-in account and the database. A
 * forbidden or unavailable read renders its own written state and is never an empty or zero report.
 */
export default async function StartingPointPage({
  searchParams,
}: {
  searchParams: Promise<{ revise?: string }>
}) {
  const { revise } = await searchParams
  const initial = await getBaselineStartingPoint()
  return (
    <div className="mx-auto w-full max-w-4xl space-y-8">
      <SectionHeader level={1} eyebrow={T.eyebrow} title={T.title} subhead={T.settingsBody} />
      <StartingPointExperience initial={initial} mode="page" startInQuiz={revise === "1"} />
    </div>
  )
}

import { createHash, randomUUID } from "node:crypto"
import Link from "next/link"

import { ErrorState } from "@/components/gradia/error-state"
import { IntakeHistoryView } from "@/components/gradia/intake-history"
import { IntakeVehicleForm } from "@/components/gradia/intake-vehicle-form"
import { Pagination } from "@/components/gradia/pagination"
import { SectionHeader } from "@/components/gradia/section-header"
import { TeamChrome } from "@/components/gradia/team-chrome"
import { loadIntakeHistory } from "@/lib/data/intake-history"
import { intakeVehicleChoicesSchema } from "@/lib/intake-vehicle"
import { requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"

export const dynamic = "force-dynamic"

const backLink =
  "inline-flex min-h-11 items-center text-sm text-accent-text underline-offset-4 hover:underline"

export default async function IntakeHistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ workflowId: string }>
  searchParams: Promise<{ shop?: string; page?: string; revision?: string }>
}) {
  await requireUser()
  const { workflowId } = await params
  const query = await searchParams
  const page = Number(query.page ?? "1")
  const revision = query.revision === undefined ? null : Number(query.revision)
  const offset =
    Number.isSafeInteger(page) && page > 0 && page < 100000 ? (page - 1) * 20 : -1
  const db = await createClient()
  const result = await loadIntakeHistory(
    db,
    query.shop ?? "",
    workflowId,
    offset,
    revision
  )
  const canChoose =
    result.ok &&
    result.history.can_link_vehicle &&
    result.history.state === "identity_linked" &&
    result.history.customer_id !== null
  const choices = canChoose
    ? await db.rpc("intake_vehicle_choices", {
        p_shop: query.shop,
        p_workflow: workflowId,
        p_revision: result.history.revision,
      })
    : null
  const parsed =
    choices && !choices.error ? intakeVehicleChoicesSchema.safeParse(choices.data) : null
  const candidates =
    parsed?.success && result.ok && parsed.data.customer_id === result.history.customer_id
      ? parsed.data
      : null
  const vehicleReviewKey =
    candidates && result.ok
      ? `${workflowId}:${result.history.revision}:${createHash("sha256")
          .update(JSON.stringify(candidates))
          .digest("hex")}`
      : ""
  const base = `/intake/${encodeURIComponent(workflowId)}?shop=${encodeURIComponent(query.shop ?? "")}`
  return (
    <TeamChrome>
      <Link href={`/intake?shop=${encodeURIComponent(query.shop ?? "")}`} className={backLink}>
        Back to intake review
      </Link>
      <SectionHeader
        level={1}
        eyebrow="Intake"
        title="Intake history"
        subhead="Evidence and owner decisions for this submission. Reading does not qualify a lead, grant consent, or send a message."
      />
      <IntakeHistoryView result={result} />
      {canChoose ? (
        candidates && result.ok ? (
          <IntakeVehicleForm
            key={vehicleReviewKey}
            shopId={query.shop!}
            workflowId={workflowId}
            revision={result.history.revision}
            commandId={randomUUID()}
            customerId={candidates.customer_id}
            customerUpdatedAt={candidates.customer_updated_at}
            vehicles={candidates.vehicles}
          />
        ) : (
          <ErrorState
            compact
            title="Vehicle choices could not be verified. Refresh before continuing."
          />
        )
      ) : null}
      <Link href={base} className={backLink}>
        Refresh history
      </Link>
      {result.ok ? (
        <Pagination
          label="History pages"
          status={`Revision ${result.history.revision} · ${result.history.total} history entries.`}
          previous={
            page > 1
              ? { href: `${base}&page=${page - 1}&revision=${result.history.revision}` }
              : null
          }
          next={
            page * 20 < result.history.total
              ? { href: `${base}&page=${page + 1}&revision=${result.history.revision}` }
              : null
          }
        />
      ) : null}
    </TeamChrome>
  )
}

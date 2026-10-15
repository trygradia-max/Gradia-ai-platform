import { createHash, randomUUID } from "node:crypto"
import Link from "next/link"

import { ErrorState } from "@/components/gradia/error-state"
import { IntakeHistoryView } from "@/components/gradia/intake-history"
import { IntakeVehicleForm } from "@/components/gradia/intake-vehicle-form"
import { Pagination } from "@/components/gradia/pagination"
import { QualificationReview } from "@/components/gradia/qualification-review"
import { SectionHeader } from "@/components/gradia/section-header"
import { TeamChrome } from "@/components/gradia/team-chrome"
import { loadIntakeHistory } from "@/lib/data/intake-history"
import { loadLeadQualification, loadLeadQualificationHistory } from "@/lib/data/lead-qualification"
import { intakeVehicleChoicesSchema } from "@/lib/intake-vehicle"
import { requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import type { SupabaseClient } from "@supabase/supabase-js"
import { threadSchema, type WhisperThread } from "@/lib/whisper-inbox"
import type { QualificationQueueThreads } from "@/components/gradia/qualification-queue"
import type { TeamWorkspace } from "@/lib/team-permissions"

export const dynamic = "force-dynamic"

/** One Whisper thread read, verified against the requested customer and
 *  channel. A failed, refused or mismatched read is null — the queue step
 *  then honestly reports no conversation instead of queueing blind. */
async function readQueueThread(
  db: SupabaseClient,
  shopId: string,
  customerId: string,
  channel: "sms" | "email"
): Promise<WhisperThread | null> {
  try {
    const response = await db.rpc("read_whisper_thread", {
      p_shop: shopId,
      p_customer: customerId,
      p_channel: channel,
      p_offset: 0,
    })
    const parsed =
      response && !response.error ? threadSchema.safeParse(response.data) : null
    const thread = parsed?.success ? parsed.data : null
    return thread &&
      thread.customer_id === customerId &&
      thread.channel === channel
      ? thread
      : null
  } catch {
    return null
  }
}

function queueThread(
  thread: WhisperThread | null,
  channel: "sms" | "email"
): { latestId: string; revision: number; destination: string } | null {
  if (!thread || !thread.can_reply || thread.state === "held") return null
  const destination = channel === "sms" ? thread.customer.phone : thread.customer.email
  if (!destination) return null
  return { latestId: thread.latest_id, revision: thread.revision, destination }
}

const backLink =
  "inline-flex min-h-11 items-center text-sm text-accent-text underline-offset-4 hover:underline"

export default async function IntakeHistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ workflowId: string }>
  searchParams: Promise<{ shop?: string; page?: string; qhpage?: string; revision?: string }>
}) {
  await requireUser()
  const { workflowId } = await params
  const query = await searchParams
  const page = Number(query.page ?? "1")
  const revision = query.revision === undefined ? null : Number(query.revision)
  const offset =
    Number.isSafeInteger(page) && page > 0 && page < 100000 ? (page - 1) * 20 : -1
  const db = await createClient()
  const workspaces = await db.rpc("team_workspaces")
  if (workspaces.error) throw new Error("Workspace access could not be verified.")
  const allowed = ((workspaces.data ?? []) as TeamWorkspace[]).filter(
    (workspace) =>
      workspace.role === "owner" ||
      (workspace.role === "manager" && workspace.capabilities.includes("crm.read"))
  )
  const workspace = query.shop ? allowed.find((item) => item.id === query.shop) : allowed[0]
  if (!workspace) {
    return (
      <TeamChrome>
        <SectionHeader
          level={1}
          eyebrow="Intake"
          title="Qualification review"
          subhead="This shop’s intake is not available to your account."
        />
        <ErrorState
          title="Intake unavailable"
          description="Owner access or a manager CRM-read grant is required. Revoked and staff memberships cannot open qualification."
          action={
            <Link href="/team" className={backLink}>
              Back to your workspaces
            </Link>
          }
        />
      </TeamChrome>
    )
  }
  const result = await loadIntakeHistory(
    db,
    workspace.id,
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
        p_shop: workspace.id,
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
  const rawHistoryPage = Number(query.qhpage ?? "1")
  const qualificationHistoryPage =
    Number.isSafeInteger(rawHistoryPage) && rawHistoryPage > 0 && rawHistoryPage < 100000
      ? rawHistoryPage
      : 1
  const shopId = workspace.id
  const [qualification, qualificationHistory, serviceRows] = await Promise.all([
    loadLeadQualification(db, shopId, workflowId),
    loadLeadQualificationHistory(db, shopId, workflowId, (qualificationHistoryPage - 1) * 20),
    shopId
      ? db.from("services").select("id,name").eq("shop_id", shopId).order("name")
      : Promise.resolve({ data: [] as { id: string; name: string }[], error: null }),
  ])
  const services =
    !serviceRows.error && Array.isArray(serviceRows.data)
      ? serviceRows.data
          .filter((row): row is { id: string; name: string } =>
            typeof row.id === "string" && typeof row.name === "string"
          )
      : []
  const base = `/intake/${encodeURIComponent(workflowId)}?shop=${encodeURIComponent(shopId)}`
  // Queue-for-approval inputs are owner-only: only the active owner may stage
  // a message, so threads are read only for owners. Everyone else sees the
  // owner-only note with no queue control. Reads reuse the existing thread
  // RPC and its authority — no new permission is introduced here.
  const isOwner = workspace.role === "owner"
  const customerId =
    qualification.ok && qualification.data.identity.customer_id
      ? qualification.data.identity.customer_id
      : null
  const [smsThread, emailThread] =
    isOwner && customerId
      ? await Promise.all([
          readQueueThread(db, shopId, customerId, "sms"),
          readQueueThread(db, shopId, customerId, "email"),
        ])
      : [null, null]
  const queueThreads: QualificationQueueThreads | null =
    isOwner && customerId
      ? { sms: queueThread(smsThread, "sms"), email: queueThread(emailThread, "email") }
      : null
  return (
    <TeamChrome>
      <Link href={`/intake?shop=${encodeURIComponent(shopId)}`} className={backLink}>
        Back to intake review
      </Link>
      <SectionHeader
        level={1}
        eyebrow="Intake"
        title="Intake history"
        subhead="Evidence and owner decisions for this submission. Qualification is reviewed below. Reading does not grant consent or send a message."
      />
      <IntakeHistoryView result={result} />
      {canChoose ? (
        candidates && result.ok ? (
          <IntakeVehicleForm
            key={vehicleReviewKey}
            shopId={shopId}
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
      <QualificationReview
        result={qualification}
        history={qualificationHistory}
        shopId={shopId}
        commandId={randomUUID()}
        services={services}
        threads={queueThreads}
        isOwner={isOwner}
      />
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
      {qualificationHistory.ok ? (
        <Pagination
          label="Qualification history pages"
          status={`Qualification history page ${qualificationHistoryPage}.`}
          previous={
            qualificationHistoryPage > 1
              ? { href: `${base}&qhpage=${qualificationHistoryPage - 1}` }
              : null
          }
          next={
            qualificationHistory.data.items.length > 20
              ? { href: `${base}&qhpage=${qualificationHistoryPage + 1}` }
              : null
          }
        />
      ) : null}
    </TeamChrome>
  )
}

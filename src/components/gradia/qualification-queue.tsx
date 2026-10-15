"use client"

import * as React from "react"
import Link from "next/link"

import { stageQualificationQuestion } from "@/app/actions/lead-qualification"
import { HelpTip } from "@/components/gradia/help-tip"
import { ReviewCard } from "@/components/gradia/review-card"
import { STRINGS } from "@/lib/strings"
import type {
  LeadQualification,
  NextQualificationQuestion,
  QualificationQuestionStageResult,
} from "@/lib/lead-qualification"
import { proposeNextQualificationQuestion } from "@/lib/lead-qualification"
import {
  QUALIFICATION_NEXT_TARGET_LABELS,
  QUALIFICATION_STAGE_CHANNEL_LABELS,
  qualificationStageOutcome,
} from "@/lib/qualification-review"
import { useRouter } from "next/navigation"
import { Loader2, MessageSquare } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { StatusPill } from "@/components/ui/status-pill"
import { Textarea } from "@/components/ui/textarea"
import { MotionCard } from "@/components/gradia/motion/motion-card"

/** One usable thread per channel, as the reviewer saw it. Null means that
 *  channel has no conversation for this customer — not an error to override. */
export type QualificationQueueThreads = {
  sms: { latestId: string; revision: number; destination: string } | null
  email: { latestId: string; revision: number; destination: string } | null
}

export type StageCommandInput = {
  shopId: string
  workflowId: string
  commandId: string
  suggestion: Extract<NextQualificationQuestion, { kind: "question" }>
  channel: "sms" | "email"
  thread: { latestId: string; revision: number; destination: string }
  body: string
  subject: string
}

/**
 * Builds the exact staging command: basis, target and question id verbatim
 * from the proposal; only the message wording is the reviewer's own. The
 * command id is created once per attempt and reused for exact retries.
 */
export function buildStageCommand(input: StageCommandInput) {
  return {
    shopId: input.shopId,
    workflowId: input.workflowId,
    commandId: input.commandId,
    basis: input.suggestion.basis,
    target: input.suggestion.target,
    questionId: input.suggestion.question_id,
    channel: input.channel,
    conversation: { latestId: input.thread.latestId, revision: input.thread.revision },
    message: {
      body: input.body,
      subject: input.channel === "email" ? input.subject : "",
      destination: input.thread.destination,
    },
  }
}

type Outcome =
  | { ok: true; status: "queued" | "already_queued"; actionId: string }
  | { ok: false; code: Extract<QualificationQuestionStageResult, { ok: false }>["code"]; field?: string }

/**
 * Owner review step that queues PR73's suggested question through PR74's
 * staging contract. Nothing here sends: a queued question waits in Approvals
 * and the existing executor still applies consent, quiet hours and A2P at
 * send time — it can still be held there. Managers never see a queue control,
 * even with qualify or approve grants; website-only leads with no thread
 * cannot be queued at all.
 */
export function QualificationQueueQuestion({
  shopId,
  workflowId,
  qualification,
  threads,
  isOwner,
}: {
  shopId: string
  workflowId: string
  qualification: LeadQualification
  threads: QualificationQueueThreads | null
  isOwner: boolean
}) {
  const router = useRouter()
  const suggestion = proposeNextQualificationQuestion(qualification)
  const [channel, setChannel] = React.useState<"sms" | "email">("sms")
  const [body, setBody] = React.useState(
    suggestion.kind === "question" ? suggestion.text : ""
  )
  const [subject, setSubject] = React.useState("")
  const [commandId] = React.useState(() => crypto.randomUUID())
  const submitted = React.useRef<ReturnType<typeof buildStageCommand> | null>(null)
  const busy = React.useRef(false)
  const [sending, setSending] = React.useState(false)
  const [fieldError, setFieldError] = React.useState<string | null>(null)
  const [outcome, setOutcome] = React.useState<Outcome | null>(null)
  const [controlHidden, setControlHidden] = React.useState(false)

  if (suggestion.kind !== "question") return null
  // Pinned with explicit types: the guards above establish these, and the
  // pins keep them stable for the queue closure below.
  const pendingQuestion: Extract<NextQualificationQuestion, { kind: "question" }> =
    suggestion

  if (!isOwner) {
    return (
      <ReviewCard
        eyebrow="Queue for approval"
        title="Owner only"
        status={<StatusPill tone="muted">Read only</StatusPill>}
        evidence={
          <p>
            Queueing a question for approval needs the shop owner. Qualifying a
            record — or being able to approve messages — is not permission to
            stage a new message.
          </p>
        }
      />
    )
  }

  const available = threads
    ? (["sms", "email"] as const).filter((c) => threads[c] !== null)
    : []
  const activeChannel = available.includes(channel) ? channel : available[0]
  const thread = activeChannel && threads ? threads[activeChannel] : null

  if (!threads || !activeChannel || !thread) {
    return (
      <ReviewCard
        eyebrow="Queue for approval"
        title="No usable conversation to queue into"
        status={<StatusPill tone="muted">Unavailable</StatusPill>}
        evidence={
          <>
            <p>
              {threads
                ? "No usable SMS or email conversation is available. A thread may be missing, held, or unreadable. Refresh and review Conversations. Queueing needs an existing conversation — a website-only lead cannot receive a first message from here."
                : "The conversations could not be loaded. Refresh before queueing anything."}
            </p>
            <p>
              This control stages into Approvals; it never sends. Send-time
              consent, quiet-hours and carrier checks still apply later.
            </p>
          </>
        }
      />
    )
  }
  const readyThread: { latestId: string; revision: number; destination: string } =
    thread

  if (controlHidden) {
    return (
      <ReviewCard
        eyebrow="Queue for approval"
        title="Not available"
        status={<StatusPill tone="muted">Hidden</StatusPill>}
        evidence={
          <p>
            Only the shop owner can queue a question. This control was removed. If an earlier attempt was uncertain, review
            Approvals before assuming it did not queue.
          </p>
        }
      />
    )
  }

  if (outcome?.ok) {
    const fresh = outcome.status === "queued"
    return (
      <ReviewCard
        eyebrow="Queue for approval"
        title={fresh ? "Queued for approval" : "Already queued"}
        status={<StatusPill tone="good">{fresh ? "Queued" : "Duplicate prevented"}</StatusPill>}
        evidence={
          <>
            <p>
              {fresh
                ? "The reviewed question is waiting in Approvals. It is not sent and not approved — the owner still approves, and send-time consent, quiet-hours and carrier checks can still hold it."
                : "This exact queue request was already staged. Nothing new was added."}
            </p>
            <p>
              <Link
                href={`/approvals/${outcome.actionId}`}
                className="underline underline-offset-4"
              >
                View in Approvals
              </Link>
            </p>
          </>
        }
      />
    )
  }

  const failure = !outcome?.ok && outcome ? outcome : null
  const guidance = failure
    ? qualificationStageOutcome(
        failure.code === "invalid" && failure.field
          ? { ok: false as const, code: "invalid" as const, field: failure.field }
          : (failure as Extract<QualificationQuestionStageResult, { ok: false }>)
      )
    : null
  const locked = sending || failure !== null

  async function queue() {
    if (busy.current || outcome?.ok || (failure && !guidance?.retrySame)) return
    if (activeChannel === "email" && subject.trim().length === 0) {
      setFieldError("An email subject is required.")
      return
    }
    if (!body.trim()) {
      setFieldError("The message cannot be empty.")
      return
    }
    setFieldError(null)
    busy.current = true
    setSending(true)
    let result: QualificationQuestionStageResult
    try {
      submitted.current ??= buildStageCommand({
          shopId,
          workflowId,
          commandId,
          suggestion: pendingQuestion,
          channel: activeChannel,
          thread: readyThread,
          body: body.trim(),
          subject: subject.trim(),
        })
      result = await stageQualificationQuestion(submitted.current)
    } catch {
      result = { ok: false, code: "uncertain" }
    }
    setSending(false)
    if (result.ok) {
      toast.success(
        result.status === "queued"
          ? "Queued for approval. Nothing is sent yet."
          : "Already queued — nothing new staged."
      )
      setOutcome({ ok: true, status: result.status, actionId: result.actionId })
      router.refresh()
      return
    }
    busy.current = false
    const mapped = qualificationStageOutcome(result)
    if (mapped.hideControl) setControlHidden(true)
    setOutcome(
      result.code === "invalid"
        ? { ok: false, code: "invalid", field: result.field }
        : { ok: false, code: result.code }
    )
    toast.error(mapped.title)
  }

  function retrySame() {
    void queue()
  }

  function startOver() {
    // A full reload keeps this stale form locked until fresh server data mounts.
    window.location.reload()
  }

  const targetLabel = QUALIFICATION_NEXT_TARGET_LABELS[pendingQuestion.target]
  const limit = activeChannel === "sms" ? 1600 : 8000

  return (
    <MotionCard interactive={false} className="space-y-4 p-6">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20">
          <MessageSquare className="size-4" aria-hidden />
        </div>
        <div className="space-y-1">
          <p className="flex items-center gap-1.5 font-medium text-foreground">
            Queue for approval
            <HelpTip label="Queue for approval" text={STRINGS.help.settings.queueForApproval} />
          </p>
          <p className="max-w-prose text-sm text-muted-foreground">
            Review the suggested {targetLabel.toLowerCase()} question, edit the
            wording if needed, and queue it. It waits in Approvals — nothing
            sends from here, and send-time checks can still hold it.
          </p>
        </div>
      </div>

      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">Channel</p>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Channel">
          {available.map((c) => (
            <Button
              key={c}
              type="button"
              variant={c === activeChannel ? "default" : "outline"}
              disabled={sending || locked}
              onClick={() => setChannel(c)}
              aria-pressed={c === activeChannel}
              className="h-10"
            >
              {QUALIFICATION_STAGE_CHANNEL_LABELS[c]}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          To {readyThread.destination} (as reviewed) · from qualification revision{" "}
          {pendingQuestion.basis.revision} · evidence revision{" "}
          {pendingQuestion.basis.evidence_revision ?? "none"} — discard if the record
          moved on.
        </p>
      </div>

      {activeChannel === "email" ? (
        <div className="space-y-1">
          <Label htmlFor="queue-subject">Subject (required for email)</Label>
          <Input
            id="queue-subject"
            maxLength={200}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            disabled={sending || locked}
            placeholder="Quick question about your inquiry"
          />
        </div>
      ) : null}

      <div className="space-y-1">
        <Label htmlFor="queue-body">Message (editable)</Label>
        <Textarea
          id="queue-body"
          value={body}
          onChange={(e) => setBody(e.target.value.slice(0, limit))}
          disabled={sending || locked}
          rows={4}
          className="resize-y"
        />
        <p className="text-xs text-muted-foreground">
          {limit - body.length} characters left · suggested wording shown — only
          the wording may be edited, not which question is asked.
        </p>
      </div>

      {fieldError ? (
        <p role="alert" className="max-w-prose rounded-md bg-status-danger-bg px-4 py-3 text-sm text-status-danger-fg">
          {fieldError}
        </p>
      ) : null}

      {guidance ? (
        <div
          role="alert"
          className="max-w-prose space-y-2 rounded-md bg-status-danger-bg px-4 py-3 text-sm text-status-danger-fg"
        >
          <p className="font-medium">{guidance.title}</p>
          <p>{guidance.description}</p>
          <div className="flex flex-wrap gap-2 pt-1">
            {guidance.retrySame ? (
              <Button
                type="button"
                onClick={retrySame}
                disabled={sending}
                className="h-10 gap-2"
              >
                {sending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                Retry this same request
              </Button>
            ) : null}
            {guidance.reload ? (
              <Button
                type="button"
                variant="outline"
                onClick={startOver}
                disabled={sending}
                className="h-10"
              >
                Reload and start over
              </Button>
            ) : null}
            {failure?.code === "question_pending" ? (
              <Link href="/approvals" className="inline-flex h-10 items-center underline underline-offset-4">
                Open Approvals
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}

      {!outcome ? (
        <Button
          type="button"
          onClick={() => void queue()}
          disabled={sending || !body.trim()}
          className="h-11 gap-2"
        >
          {sending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          Queue for approval
        </Button>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Owner only. Queueing stages a pending approval — it never sends, and a
        queued message can still be held by send-time checks.
      </p>
    </MotionCard>
  )
}

"use client"

import { useEffect, useId, useRef, useState, useTransition, type FormEvent } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { updateWhisperInbox } from "@/app/actions/whisper-inbox"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { threadStateLabels, type WhisperThread } from "@/lib/whisper-inbox"
import { cn } from "@/lib/utils"

type HandoffState = "needs_reply" | "held" | "completed"
type Feedback = { tone: "status" | "alert"; text: string }
type FieldError = {
  field: "reason" | "subject" | "body" | "destination"
  text: string
}

const fieldClass =
  "mt-1.5 min-h-11 w-full text-base md:text-sm"
const selectClass =
  "mt-1.5 block min-h-11 w-full rounded-sm border border-input bg-transparent px-2.5 py-2 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm"
const buttonClass =
  "inline-flex min-h-11 w-full items-center justify-center rounded-sm border border-border bg-background px-3 text-sm font-medium outline-none hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 sm:w-auto"
const primaryButtonClass =
  "inline-flex min-h-11 w-full items-center justify-center rounded-sm bg-primary px-3 text-sm font-medium text-primary-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 sm:w-auto"

function handoffState(state: WhisperThread["state"]): HandoffState {
  if (state === "held" || state === "completed") return state
  return "needs_reply"
}

function describedBy(ids: Array<string | false | undefined>): string | undefined {
  const value = ids.filter((id): id is string => Boolean(id)).join(" ")
  return value || undefined
}

export function WhisperInboxControls({
  shopId,
  thread,
  commands,
}: {
  shopId: string
  thread: WhisperThread
  commands: {
    read: string
    handoff: string
    reply: string
  }
}) {
  const router = useRouter()
  const baseId = useId()
  const feedbackRef = useRef<HTMLParagraphElement>(null)
  const fieldErrorRef = useRef<HTMLParagraphElement>(null)
  const [busy, start] = useTransition()
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [fieldError, setFieldError] = useState<FieldError | null>(null)
  const [assignee, setAssignee] = useState(thread.assignee_id ?? "")
  const [state, setState] = useState<HandoffState>(handoffState(thread.state))
  const [reason, setReason] = useState(thread.reason)
  const [body, setBody] = useState("")
  const [subject, setSubject] = useState("")

  const assigneeId = `${baseId}-assignee`
  const stateId = `${baseId}-state`
  const reasonId = `${baseId}-reason`
  const subjectId = `${baseId}-subject`
  const bodyId = `${baseId}-body`
  const readHintId = `${baseId}-read-hint`
  const handoffHintId = `${baseId}-handoff-hint`
  const stateHintId = `${baseId}-state-hint`
  const reasonHintId = `${baseId}-reason-hint`
  const replyHintId = `${baseId}-reply-hint`
  const recipientId = `${baseId}-recipient`
  const fieldErrorId = `${baseId}-field-error`
  const headingId = `${baseId}-heading`
  const destination =
    thread.channel === "sms" ? thread.customer.phone : thread.customer.email
  const replyLimit = thread.channel === "sms" ? 1600 : 8000
  useEffect(() => {
    if (fieldError) fieldErrorRef.current?.focus()
  }, [fieldError])

  useEffect(() => {
    if (feedback) feedbackRef.current?.focus()
  }, [feedback])

  function showFieldError(field: FieldError["field"], text: string) {
    setFeedback(null)
    setFieldError({ field, text })
  }

  function run(operation: "read" | "handoff" | "reply", payload: unknown) {
    setFieldError(null)
    setFeedback(null)
    start(async () => {
      try {
        const result = await updateWhisperInbox({
          shopId,
          customerId: thread.customer_id,
          channel: thread.channel,
          latestId: thread.latest_id,
          revision: thread.revision,
          commandId: commands[operation],
          operation,
          payload,
        })
        setFeedback({ tone: result.ok ? "status" : "alert", text: result.message })
        if (result.ok) {
          toast.success(result.message)
          router.refresh()
        } else {
          toast.error(result.message)
        }
      } catch {
        const text = "Result uncertain. Refresh before retrying."
        setFeedback({ tone: "alert", text })
        toast.error(text)
      }
    })
  }

  function submitHandoff(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    if (state === "held" && reason.trim().length === 0) {
      showFieldError("reason", "A reason is required to hold this conversation.")
      return
    }
    run("handoff", { assignee_id: assignee || null, state, reason })
  }

  function submitReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    if (thread.channel === "email" && subject.trim().length === 0) {
      showFieldError("subject", "An email subject is required.")
      return
    }
    if (body.trim().length === 0) {
      showFieldError("body", "Write the reply before queueing it for approval.")
      return
    }
    if (!destination) {
      showFieldError("destination", "No recipient is on file. Refresh before queueing a draft.")
      return
    }
    run("reply", { body, subject, destination })
  }

  return (
    <section className="space-y-5" aria-labelledby={headingId} aria-busy={busy}>
      <h2 id={headingId} className="font-display text-lg text-foreground">
        Conversation controls
      </h2>
      {busy ? (
        <p role="status" className="text-sm text-muted-foreground">
          Waiting for confirmation. Do not retry until this finishes.
        </p>
      ) : null}
      <div className="space-y-2">
        <p id={readHintId} className="max-w-prose text-sm text-muted-foreground">
          Marks the latest visible messages read for your account only. It does not
          send a message or change any other account.
        </p>
        <button
          type="button"
          disabled={busy}
          aria-describedby={readHintId}
          onClick={() => run("read", {})}
          className={buttonClass}
        >
          Mark read for me
        </button>
      </div>
      {thread.can_manage ? (
        <form
          className="space-y-4 rounded-md bg-card p-4 ring-1 ring-foreground/10 sm:p-5"
          onSubmit={submitHandoff}
        >
          <h3 className="font-display text-base text-foreground">Assignment and handoff</h3>
          <p id={stateHintId} className="max-w-prose text-sm text-muted-foreground">
            Current state: {threadStateLabels[thread.state]}. Saving records the state
            selected below. Awaiting approval stays visible until the approval itself
            changes, and this form does not pause queued delivery.
          </p>
          <label htmlFor={assigneeId} className="block text-sm font-medium">
            Responsible operator
            <select
              id={assigneeId}
              className={selectClass}
              value={assignee}
              onChange={(event) => setAssignee(event.target.value)}
              disabled={busy}
            >
              <option value="">Owner fallback</option>
              {thread.members.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor={stateId} className="block text-sm font-medium">
            Work state
            <select
              id={stateId}
              className={selectClass}
              value={state}
              aria-describedby={stateHintId}
              onChange={(event) => {
                const value = event.target.value
                const next: HandoffState =
                  value === "held" || value === "completed" ? value : "needs_reply"
                setState(next)
                if (next !== "held") setFieldError(null)
              }}
              disabled={busy}
            >
              <option value="needs_reply">Needs reply</option>
              <option value="held">Held for review</option>
              <option value="completed">Completed by operator</option>
            </select>
          </label>
          <label htmlFor={reasonId} className="block text-sm font-medium">
            Handoff reason
            <Textarea
              id={reasonId}
              className={cn(fieldClass, "min-h-24")}
              value={reason}
              maxLength={1000}
              required={state === "held"}
              aria-required={state === "held"}
              aria-invalid={fieldError?.field === "reason" ? true : undefined}
              aria-describedby={describedBy([
                reasonHintId,
                handoffHintId,
                fieldError?.field === "reason" ? fieldErrorId : undefined,
              ])}
              onChange={(event) => setReason(event.target.value)}
              onInvalid={(event) => {
                event.preventDefault()
                showFieldError("reason", "A reason is required to hold this conversation.")
              }}
              disabled={busy}
            />
          </label>
          <p id={reasonHintId} className="text-xs text-muted-foreground">
            {reason.length} / 1000 characters.
            {state === "held"
              ? " Required while work is held for review."
              : " Optional unless you hold the work for review."}
          </p>
          <p id={handoffHintId} className="max-w-prose text-sm text-muted-foreground">
            Completion does not mean a message was delivered. Handoff flags do not
            pause or cancel queued actions; manage those in Approvals. Pending
            approvals and uncertain execution remain visible.
          </p>
          <button type="submit" disabled={busy} className={primaryButtonClass}>
            Save handoff
          </button>
        </form>
      ) : null}
      {thread.channel === "voice" ? (
        <p className="max-w-prose text-sm text-muted-foreground">
          Voice history can be read on this page. This screen does not stage a call
          reply.
        </p>
      ) : null}
      {thread.can_reply && thread.channel !== "voice" ? (
        <form
          className="space-y-4 rounded-md bg-card p-4 ring-1 ring-foreground/10 sm:p-5"
          onSubmit={submitReply}
        >
          <h3 className="font-display text-base text-foreground">Draft reply for approval</h3>
          <p id={recipientId} className="break-words text-sm" style={{ overflowWrap: "anywhere" }}>
            Recipient:{" "}
            {destination ??
              (thread.channel === "sms"
                ? "No phone number is on file, so a draft cannot be queued."
                : "No email address is on file, so a draft cannot be queued.")}
          </p>
          {thread.channel === "email" ? (
            <label htmlFor={subjectId} className="block text-sm font-medium">
              Subject
              <Input
                id={subjectId}
                className={fieldClass}
                required
                maxLength={200}
                value={subject}
                aria-invalid={fieldError?.field === "subject" ? true : undefined}
                aria-describedby={describedBy([
                  replyHintId,
                  fieldError?.field === "subject" ? fieldErrorId : undefined,
                ])}
                onChange={(event) => setSubject(event.target.value)}
                onInvalid={(event) => {
                  event.preventDefault()
                  showFieldError("subject", "An email subject is required.")
                }}
                disabled={busy}
              />
            </label>
          ) : null}
          <label htmlFor={bodyId} className="block text-sm font-medium">
            Reply
            <Textarea
              id={bodyId}
              className={cn(fieldClass, "min-h-28")}
              required
              maxLength={replyLimit}
              value={body}
              aria-invalid={fieldError?.field === "body" ? true : undefined}
              aria-describedby={describedBy([
                replyHintId,
                recipientId,
                fieldError?.field === "body" ? fieldErrorId : undefined,
              ])}
              onChange={(event) => setBody(event.target.value)}
              onInvalid={(event) => {
                event.preventDefault()
                showFieldError("body", "Write the reply before queueing it for approval.")
              }}
              disabled={busy}
            />
          </label>
          <p id={replyHintId} className="max-w-prose text-sm text-muted-foreground">
            {body.length} / {replyLimit} characters. Queues through the existing
            approval and send checks. Marketing consent is required; this composer
            cannot assert a service-purpose exemption. Email is a new outbound draft,
            not yet a provider-threaded reply.
          </p>
          <button disabled={busy || !destination} type="submit" className={primaryButtonClass} aria-describedby={describedBy([recipientId, replyHintId])}>Queue draft in Approvals</button>
        </form>
      ) : null}
      {fieldError ? (
        <p
          ref={fieldErrorRef}
          id={fieldErrorId}
          tabIndex={-1}
          role="alert"
          className="rounded-md bg-status-danger-bg px-3 py-2 text-sm text-status-danger-fg outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {fieldError.text}
        </p>
      ) : null}
      {feedback ? (
        <p
          ref={feedbackRef}
          tabIndex={-1}
          role={feedback.tone === "alert" ? "alert" : "status"}
          className={cn(
            "rounded-md px-3 py-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
            feedback.tone === "alert"
              ? "bg-status-danger-bg text-status-danger-fg"
              : "bg-muted text-foreground"
          )}
        >
          {feedback.text}
        </p>
      ) : null}
    </section>
  )
}

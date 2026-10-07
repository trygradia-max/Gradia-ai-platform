"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { updateWhisperInbox } from "@/app/actions/whisper-inbox"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import type { WhisperThread } from "@/lib/whisper-inbox"

const field =
  "mt-1 w-full rounded-md border border-border/70 bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"

export function WhisperInboxControls({
  shopId,
  thread,
  commands,
}: {
  shopId: string
  thread: WhisperThread
  commands: { read: string; handoff: string; reply: string }
}) {
  const [busy, start] = useTransition()
  const [message, setMessage] = useState("")
  const router = useRouter()
  const [assignee, setAssignee] = useState(thread.assignee_id ?? "")
  const [state, setState] = useState("needs_reply")
  const [reason, setReason] = useState("")
  const [body, setBody] = useState("")
  const [subject, setSubject] = useState("")
  const destination =
    thread.channel === "sms" ? thread.customer.phone : thread.customer.email

  function run(operation: "read" | "handoff" | "reply", payload: unknown) {
    start(async () => {
      try {
        const r = await updateWhisperInbox({
          shopId,
          customerId: thread.customer_id,
          channel: thread.channel,
          latestId: thread.latest_id,
          revision: thread.revision,
          commandId: commands[operation],
          operation,
          payload,
        })
        setMessage(r.message)
        if (r.ok) {
          toast.success(r.message)
          router.refresh()
        }
      } catch {
        setMessage("Result uncertain. Refresh before retrying.")
      }
    })
  }

  return (
    <section
      className="max-h-[46%] space-y-4 overflow-y-auto border-t border-border/70 bg-background px-4 py-3 pb-28 sm:pb-4"
      aria-label="Conversation controls"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => run("read", {})}
        >
          Mark read for me
        </Button>
        {message ? (
          <p role="status" className="text-sm text-muted-foreground">
            {message}
          </p>
        ) : null}
      </div>

      {thread.can_manage ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            run("handoff", { assignee_id: assignee || null, state, reason })
          }}
        >
          <h2 className="text-sm font-medium">Assignment</h2>
          <label className="block text-xs text-muted-foreground">
            Responsible operator
            <select
              className={field}
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
              disabled={busy}
            >
              <option value="">Owner fallback</option>
              {thread.members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs text-muted-foreground">
            Work state
            <select
              className={field}
              value={state}
              onChange={(e) => setState(e.target.value)}
              disabled={busy}
            >
              <option value="needs_reply">Needs reply</option>
              <option value="held">Held for review</option>
              <option value="completed">Completed by operator</option>
            </select>
          </label>
          <label className="block text-xs text-muted-foreground">
            Handoff reason
            <Textarea
              className="mt-1"
              value={reason}
              maxLength={1000}
              required={state === "held"}
              onChange={(e) => setReason(e.target.value)}
              disabled={busy}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            Completing this does not mean a message was delivered. Handoff
            does not pause queued actions. Manage those in Approvals.
          </p>
          <Button type="submit" variant="outline" disabled={busy}>
            Save handoff
          </Button>
        </form>
      ) : null}

      {thread.can_reply && thread.channel !== "voice" ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            run("reply", { body, subject, destination })
          }}
        >
          <h2 className="text-sm font-medium">Draft a reply</h2>
          <p className="text-xs text-muted-foreground">
            Recipient: {destination || "No destination on file"}
          </p>
          {thread.channel === "email" ? (
            <label className="block text-xs text-muted-foreground">
              Subject
              <input
                className={field}
                required
                maxLength={200}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                disabled={busy}
              />
            </label>
          ) : null}
          <label className="block text-xs text-muted-foreground">
            Reply
            <Textarea
              className="mt-1 min-h-24"
              required
              maxLength={thread.channel === "sms" ? 1600 : 8000}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              disabled={busy}
              placeholder="Write the reply. It waits for approval before anything is sent."
            />
          </label>
          <p className="text-xs text-muted-foreground">
            This queues through the existing approval and send checks.
            Marketing consent is required. Email is a new outbound draft, not
            a threaded reply in the mailbox yet.
          </p>
          <Button type="submit" disabled={busy || !destination}>
            Queue draft in Approvals
          </Button>
        </form>
      ) : null}
    </section>
  )
}

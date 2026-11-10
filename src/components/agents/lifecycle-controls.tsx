"use client"

import { useRouter } from "next/navigation"
import { useId, useState, useTransition } from "react"

import { pauseOrBlockAgentDefinition } from "@/app/actions/agent-definitions"
import { FormField } from "@/components/gradia/form-field"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { interpretLifecycle, type LifecycleOutcome } from "@/lib/agent-os/builder/results"

const REASON_MAX = 200

/**
 * Owner-only pause / block of the ACTIVE definition. A reason is required, the exact pointer
 * the owner is looking at is sent, and confirmation is explicit. There is no resume shortcut:
 * resuming is a fresh activation with fresh evidence.
 */
export function LifecycleControls({ agentId, expectedPointer }: { agentId: string; expectedPointer: number }) {
  const router = useRouter()
  const reasonId = useId()
  const [mode, setMode] = useState<"paused" | "blocked" | null>(null)
  const [reason, setReason] = useState("")
  const [message, setMessage] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const close = () => {
    if (pending) return
    setMode(null)
    setReason("")
    setMessage(null)
  }

  const reasonProblem = reason.trim().length === 0 ? "Enter a reason so your team knows why." : reason.trim().length > REASON_MAX ? `Use ${REASON_MAX} characters or fewer.` : null

  function confirm() {
    if (!mode || reasonProblem) {
      setMessage(reasonProblem)
      return
    }
    startTransition(async () => {
      let outcome: LifecycleOutcome
      try {
        outcome = interpretLifecycle(await pauseOrBlockAgentDefinition({ agentId, lifecycle: mode, reason: reason.trim(), expectedPointer }))
      } catch {
        outcome = { kind: "error", message: "Gradia could not change this agent right now. Nothing was changed. Try again." }
      }
      if (outcome.kind === "changed" || outcome.kind === "unchanged") {
        setMode(null)
        setReason("")
        router.refresh()
        return
      }
      if (outcome.kind === "stale") {
        setMessage("This agent's active revision changed after you opened this page. Reload to see the current state, then try again.")
        return
      }
      setMessage(outcome.message)
    })
  }

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" className="min-h-11" onClick={() => setMode("paused")}>
          Pause agent
        </Button>
        <Button type="button" variant="destructive" className="min-h-11" onClick={() => setMode("blocked")}>
          Block agent
        </Button>
      </div>
      <Dialog open={mode !== null} onOpenChange={(open) => !open && close()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{mode === "blocked" ? "Block this agent?" : "Pause this agent?"}</DialogTitle>
            <DialogDescription>
              It stops starting new runs right away. To turn it back on you&apos;ll activate a revision again, with fresh checks. Nothing is deleted.
            </DialogDescription>
          </DialogHeader>
          <FormField id={reasonId} label="Reason" hint={`Required. ${REASON_MAX} characters or fewer. Your team can read this.`} error={message}>
            <Textarea value={reason} maxLength={REASON_MAX + 50} rows={3} onChange={(e) => setReason(e.target.value)} />
          </FormField>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button type="button" variant="ghost" className="h-11 sm:h-9" disabled={pending} onClick={close}>
              Cancel
            </Button>
            <Button type="button" variant={mode === "blocked" ? "destructive" : "default"} className="h-11 sm:h-9" disabled={pending} onClick={confirm}>
              {pending ? "Saving…" : mode === "blocked" ? "Block agent" : "Pause agent"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

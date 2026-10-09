"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"

import { approveDelegatedMessage, rejectDelegatedMessage } from "@/app/actions/delegated-approvals"

const uncertain = "Result uncertain. Do not decide again; ask the shop owner to review this message."

export function DelegatedApproveButton({ shopId, actionId, reviewHash }: {
  shopId: string; actionId: string; reviewHash: string
}) {
  const router = useRouter()
  const [message, setMessage] = useState("")
  const [submitted, setSubmitted] = useState<"approve" | "reject" | null>(null)
  const [pending, startTransition] = useTransition()
  const decide = (decision: "approve" | "reject") => {
    if (submitted || pending) return
    setSubmitted(decision)
    startTransition(async () => {
      try {
        const command = { shopId, actionId, reviewHash }
        const result = decision === "approve" ? await approveDelegatedMessage(command) : await rejectDelegatedMessage(command)
        setMessage(result.message)
        if (result.ok) router.refresh()
      } catch {
        setMessage(uncertain)
      }
    })
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-3">
        <button type="button" className="rounded border px-4 py-2" disabled={Boolean(submitted) || pending} onClick={() => decide("approve")}>
          {pending && submitted === "approve" ? "Approving…" : "Approve and send this message"}
        </button>
        <button type="button" className="rounded border px-4 py-2" disabled={Boolean(submitted) || pending} onClick={() => decide("reject")}>
          {pending && submitted === "reject" ? "Rejecting…" : "Reject — do not send"}
        </button>
      </div>
      {message && <p role="status">{message}</p>}
      {submitted && !pending && <p>Refresh this page before deciding anything else.</p>}
    </div>
  )
}

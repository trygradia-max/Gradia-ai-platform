"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"

import { approveDelegatedMessage } from "@/app/actions/delegated-approvals"

export function DelegatedApproveButton({ shopId, actionId, reviewHash }: {
  shopId: string; actionId: string; reviewHash: string
}) {
  const router = useRouter()
  const [message, setMessage] = useState("")
  const [submitted, setSubmitted] = useState(false)
  const [pending, startTransition] = useTransition()
  return (
    <div className="space-y-2">
      <button
        type="button"
        className="rounded border px-4 py-2"
        disabled={submitted || pending}
        onClick={() => {
          if (submitted || pending) return
          setSubmitted(true)
          startTransition(async () => {
            try {
              const result = await approveDelegatedMessage({ shopId, actionId, reviewHash })
              setMessage(result.message)
              if (result.ok) router.refresh()
            } catch {
              setMessage("Result uncertain. Do not approve again; ask the shop owner to review this message.")
            }
          })
        }}
      >
        {pending ? "Approving…" : "Approve and send this message"}
      </button>
      {message && <p role="status">{message}</p>}
      {submitted && !pending && <p>Refresh this page before deciding anything else.</p>}
    </div>
  )
}

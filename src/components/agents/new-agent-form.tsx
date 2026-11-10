"use client"

import { useRouter } from "next/navigation"
import { useId, useState, useTransition } from "react"

import { createGradiaAgentIdentity } from "@/app/actions/agent-definitions"
import { FormField } from "@/components/gradia/form-field"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { AGENT_NAME_BOUNDS, validateAgentName } from "@/lib/agent-os/identity-store"

const FAILURE_COPY: Record<string, string> = {
  forbidden: "Only the workspace owner can create an agent.",
  invalid_name: `Use ${AGENT_NAME_BOUNDS.min}–${AGENT_NAME_BOUNDS.max} characters, without special symbols.`,
  limit_reached: "This workspace has reached the limit for Gradia agents. Remove an unused one first.",
  unavailable: "Gradia could not create the agent right now. Nothing was created. Try again.",
}

/** Step zero: a bounded display name creates a DISABLED identity, then the exact agent's builder opens. */
export function NewAgentForm() {
  const router = useRouter()
  const inputId = useId()
  const [name, setName] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function submit(event: React.FormEvent) {
    event.preventDefault()
    if (pending) return
    if (!validateAgentName(name).ok) {
      setError(FAILURE_COPY.invalid_name)
      return
    }
    setError(null)
    startTransition(async () => {
      const result = await createGradiaAgentIdentity({ name })
      if (result.ok) {
        router.replace(`/agents/build?agent=${result.agentId}&step=job`)
        return
      }
      setError(FAILURE_COPY[result.code] ?? FAILURE_COPY.unavailable)
    })
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <FormField
        id={inputId}
        label="Agent name"
        hint="Only your team sees this name. You can describe the job in the next step. Nothing runs and nothing is charged."
        error={error}
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={AGENT_NAME_BOUNDS.max} autoComplete="off" placeholder="Quote follow-up" className="min-h-11 sm:min-h-8" />
      </FormField>
      <Button type="submit" disabled={pending} className="min-h-11">
        {pending ? "Creating…" : "Create and continue"}
      </Button>
    </form>
  )
}

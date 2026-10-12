"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { linkIntakeIdentity } from "@/app/actions/intake-identity"
import { FormField } from "@/components/gradia/form-field"
import { Button } from "@/components/ui/button"
import type { IntakeCustomer } from "@/lib/intake-identity"

export function IntakeIdentityForm({
  shopId,
  workflowId,
  revision,
  commandId,
  customers,
}: {
  shopId: string
  workflowId: string
  revision: number
  commandId: string
  customers: IntakeCustomer[]
}) {
  const [selected, setSelected] = useState("")
  const [confirmed, setConfirmed] = useState(false)
  const [message, setMessage] = useState("")
  const [failed, setFailed] = useState(false)
  const [busy, start] = useTransition()
  const router = useRouter()
  const customer = customers.find((c) => c.id === selected)
  const selectError =
    failed && !customer ? "Choose a customer and confirm the reviewed identity first." : undefined

  return (
    <form
      className="space-y-3 border-t border-border pt-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (!customer || !confirmed) return
        start(async () => {
          try {
            const result = await linkIntakeIdentity({
              shopId,
              workflowId,
              revision,
              commandId,
              customer,
              confirmed,
            })
            setMessage(result.message)
            setFailed(!result.ok)
            if (result.ok) {
              toast.success(result.message)
              router.push(`/intake/${workflowId}?shop=${shopId}`)
            }
          } catch {
            setFailed(true)
            setMessage("Result uncertain. Refresh the queue before retrying.")
          }
        })
      }}
    >
      <FormField
        id={`intake-customer-${workflowId}`}
        label="Link to an existing customer"
        hint="Choose explicitly — no automatic match. Searching or similar contact text does not select an identity."
        error={selectError}
      >
        <select
          aria-label="Existing customer"
          className="h-11 w-full rounded-sm border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
          value={selected}
          disabled={busy}
          onChange={(e) => {
            setSelected(e.target.value)
            setConfirmed(false)
            setFailed(false)
            setMessage("")
          }}
        >
          <option value="">Choose explicitly — no automatic match</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name ?? "Unnamed customer"} · {c.phone ?? "No phone"} · {c.email ?? "No email"}
            </option>
          ))}
        </select>
      </FormField>
      <label className="flex min-h-11 items-start gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          className="mt-1 size-4 accent-primary"
          checked={confirmed}
          disabled={!customer || busy}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        I checked the submitted information and confirm this is the selected customer. This does not
        grant communication consent.
      </label>
      <Button type="submit" className="min-h-11" disabled={!customer || !confirmed || busy}>
        {busy ? "Recording…" : "Confirm identity link"}
      </Button>
      {message ? (
        <p role={failed ? "alert" : "status"} className="text-sm">
          {message}
        </p>
      ) : null}
    </form>
  )
}

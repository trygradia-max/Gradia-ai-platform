"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { linkIntakeVehicle } from "@/app/actions/intake-vehicle"
import { FormField } from "@/components/gradia/form-field"
import { Button } from "@/components/ui/button"
import type { IntakeVehicle } from "@/lib/intake-vehicle"

export function IntakeVehicleForm({
  shopId,
  workflowId,
  revision,
  commandId,
  customerId,
  customerUpdatedAt,
  vehicles,
}: {
  shopId: string
  workflowId: string
  revision: number
  commandId: string
  customerId: string
  customerUpdatedAt: string
  vehicles: IntakeVehicle[]
}) {
  const [selected, setSelected] = useState("")
  const [confirmed, setConfirmed] = useState(false)
  const [message, setMessage] = useState("")
  const [failed, setFailed] = useState(false)
  const [busy, start] = useTransition()
  const router = useRouter()
  const vehicle = vehicles.find((v) => v.id === selected)

  return (
    <form
      className="space-y-3 rounded-md bg-card p-5 ring-1 ring-border sm:p-6"
      onSubmit={(event) => {
        event.preventDefault()
        if (!vehicle || !confirmed) return
        start(async () => {
          try {
            const result = await linkIntakeVehicle({
              shopId,
              workflowId,
              revision,
              commandId,
              customerId,
              customerUpdatedAt,
              vehicle,
              confirmed,
            })
            setMessage(result.message)
            setFailed(!result.ok)
            if (result.ok) {
              toast.success(result.message)
              router.refresh()
            }
          } catch {
            setFailed(true)
            setMessage("Result uncertain. Refresh history before retrying.")
          }
        })
      }}
    >
      <h2 className="font-display text-xl text-foreground">Confirm the customer’s vehicle</h2>
      <p className="text-sm text-muted-foreground">
        Review the submitted evidence first. Up to 50 existing vehicles for this customer are shown.
        Missing vehicles stay unresolved; add genuine vehicles through the CRM.
      </p>
      <FormField
        id={`intake-vehicle-${workflowId}`}
        label="Existing vehicle"
        hint="Choose explicitly — no automatic match from submitted text."
      >
        <select
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
          {vehicles.map((v) => (
            <option key={v.id} value={v.id}>
              {[v.year, v.make, v.model, v.color, v.plate].filter(Boolean).join(" · ") ||
                "Vehicle details missing"}{" "}
              · {v.id}
            </option>
          ))}
        </select>
      </FormField>
      {!vehicles.length ? <p>No existing vehicles available for this customer.</p> : null}
      <label className="flex min-h-11 items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1 size-4 accent-primary"
          checked={confirmed}
          disabled={!vehicle || busy}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        I checked the intake evidence and confirm this vehicle. This grants no communication consent.
      </label>
      <Button type="submit" className="min-h-11" disabled={!vehicle || !confirmed || busy}>
        {busy ? "Recording…" : "Confirm vehicle"}
      </Button>
      {message ? (
        <p role={failed ? "alert" : "status"} className="text-sm">
          {message}
        </p>
      ) : null}
    </form>
  )
}

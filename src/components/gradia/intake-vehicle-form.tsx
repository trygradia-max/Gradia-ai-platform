"use client"
import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { linkIntakeVehicle } from "@/app/actions/intake-vehicle"
import type { IntakeVehicle } from "@/lib/intake-vehicle"

export function IntakeVehicleForm({ shopId, workflowId, revision, commandId, customerId, customerUpdatedAt, vehicles }: {
  shopId: string; workflowId: string; revision: number; commandId: string;
  customerId: string; customerUpdatedAt: string; vehicles: IntakeVehicle[];
}) {
  const [selected, setSelected] = useState(""), [confirmed, setConfirmed] = useState(false)
  const [message, setMessage] = useState(""), [busy, start] = useTransition(), router = useRouter()
  const vehicle = vehicles.find(v => v.id === selected)
  return <form className="space-y-3 rounded border p-4" onSubmit={event => {
    event.preventDefault()
    if (!vehicle || !confirmed) return
    start(async () => {
      try {
        const result = await linkIntakeVehicle({ shopId, workflowId, revision, commandId, customerId, customerUpdatedAt, vehicle, confirmed })
        setMessage(result.message)
        if (result.ok) { toast.success(result.message); router.refresh() }
      } catch { setMessage("Result uncertain. Refresh history before retrying.") }
    })
  }}>
    <h2 className="font-semibold">Confirm the customer’s vehicle</h2>
    <p className="text-sm">Review the submitted evidence first. Up to 50 existing vehicles for this customer are shown. Missing vehicles stay unresolved; add genuine vehicles through the CRM.</p>
    <label className="block">Existing vehicle<select className="block w-full rounded border bg-background p-2" value={selected} disabled={busy} onChange={e => { setSelected(e.target.value); setConfirmed(false) }}>
      <option value="">Choose explicitly — no automatic match</option>
      {vehicles.map(v => <option key={v.id} value={v.id}>{[v.year, v.make, v.model, v.color, v.plate].filter(Boolean).join(" · ") || "Vehicle details missing"} · {v.id}</option>)}
    </select></label>
    {!vehicles.length ? <p>No existing vehicles available for this customer.</p> : null}
    <label className="flex gap-2"><input type="checkbox" checked={confirmed} disabled={!vehicle || busy} onChange={e => setConfirmed(e.target.checked)} />I checked the intake evidence and confirm this vehicle. This grants no communication consent.</label>
    <button disabled={!vehicle || !confirmed || busy} className="rounded border px-3 py-2 disabled:opacity-50">{busy ? "Recording…" : "Confirm vehicle"}</button>
    {message ? <p role="status">{message}</p> : null}
  </form>
}

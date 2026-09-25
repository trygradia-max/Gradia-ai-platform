"use client"

import { useState, useTransition } from "react"
import { savePolicyDraft } from "@/app/actions/control-center"
import { ACTIONS, modes, type Mode, type Operation } from "@/lib/control-center/policy"
import { connectors, risks, exceptions, operationLabels, type PolicyDraft } from "@/lib/control-center/drafts"

const labels: Record<Mode, string> = { off: "Off", read: "Read", suggest: "Suggest privately", approval: "Approval required", autonomous: "Autonomous" }
function ModeField({ label, value, inherit = true, onChange }: { label: string; value: Mode | null; inherit?: boolean; onChange: (value: Mode | null) => void }) {
  return <label className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm"><span>{label}</span>
    <select aria-label={label} className="rounded-sm border bg-background p-2" value={value ?? "inherit"} onChange={e => onChange(e.target.value === "inherit" ? null : e.target.value as Mode)}>
      {inherit && <option value="inherit">Inherit</option>}
      {modes.map(mode => <option key={mode} value={mode}>{labels[mode]}</option>)}
    </select></label>
}
export function PolicyDraftEditor({ shopId, revision, initial }: { shopId: string; revision: number; initial: PolicyDraft }) {
  const [draft, setDraft] = useState(initial)
  const [currentRevision, setRevision] = useState(revision)
  const [message, setMessage] = useState("")
  const [pending, startTransition] = useTransition()
  function updateMap(key: "connectorCeilings" | "actionGrants" | "roleCeilings" | "riskCeilings" | "exceptionCeilings", scope: string, value: Mode | null) {
    setDraft(previous => ({ ...previous, [key]: { ...previous[key], [scope]: value } }))
  }
  return <form className="space-y-5" onSubmit={event => {
    event.preventDefault(); setMessage("")
    startTransition(async () => {
      try {
        const result = await savePolicyDraft({ shopId, expectedRevision: currentRevision, definition: draft })
        if (result.ok) { setRevision(result.revision); setMessage(`Draft revision ${result.revision} saved. Current execution is unchanged.`) }
        else setMessage(result.error)
      } catch { setMessage("The save could not be confirmed. Reload to check the revision before retrying.") }
    })
  }}>
    <fieldset disabled={pending} className="space-y-4">
      <section className="rounded-md border p-4">
        <h2 className="font-medium">Workspace · draft revision {currentRevision}</h2>
        <label className="flex gap-2 py-3 text-sm"><input type="checkbox" checked={draft.enabled} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} />Enable business automation in this draft</label>
        <ModeField label="Default for inherited operations" value={draft.workspaceDefault} onChange={value => setDraft({ ...draft, workspaceDefault: value })} />
        <ModeField label="Maximum workspace mode" value={draft.workspaceCeiling} inherit={false} onChange={value => value && setDraft({ ...draft, workspaceCeiling: value })} />
        <ModeField label="Current location ceiling" value={draft.locationCeiling} onChange={value => setDraft({ ...draft, locationCeiling: value })} />
      </section>
      <section className="rounded-md border p-4"><h2 className="font-medium">Connector ceilings</h2>
        <p className="text-sm text-muted-foreground">These restrict individual operations. Mandatory suppression and security processing remain separate.</p>
        {connectors.map(connector => <ModeField key={connector} label={connector === "crm" ? "Customers and jobs" : connector === "internal" ? "Internal records" : connector === "sms" ? "SMS" : connector.charAt(0).toUpperCase() + connector.slice(1)} value={draft.connectorCeilings[connector] ?? null} onChange={value => updateMap("connectorCeilings", connector, value)} />)}
      </section>
      <details className="rounded-md border p-4"><summary className="cursor-pointer font-medium">Custom operation rules</summary>
        <p className="py-2 text-sm text-muted-foreground">Custom combines individual rules within applicable ceilings. Existing safety floors still apply; an Autonomous choice cannot remove a hard approval requirement.</p>
        {Object.entries(ACTIONS).map(([operation, definition]) => <ModeField key={operation} label={`${operationLabels[operation as Operation]} · initial: ${labels[definition.initial]}`} value={draft.actionGrants[operation] ?? null} onChange={value => updateMap("actionGrants", operation, value)} />)}
      </details>
      <details className="rounded-md border p-4"><summary className="cursor-pointer font-medium">Role, risk and exception ceilings</summary>
        <p className="py-2 text-sm text-muted-foreground">Ceilings only restrict behavior. They do not grant role permissions or allow safety exceptions.</p>
        {([ ["roleCeilings", ["owner", "manager", "staff"]], ["riskCeilings", risks], ["exceptionCeilings", exceptions] ] as const).map(([key, scopes]) => scopes.map(scope => <ModeField key={`${key}:${scope}`} label={scope.replaceAll("_", " ")} value={draft[key][scope] ?? null} onChange={value => updateMap(key, scope, value)} />))}
      </details>
      <button className="rounded-sm bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50" type="submit">{pending ? "Saving draft…" : "Save draft"}</button>
    </fieldset>
    <p role="status" aria-live="polite" className="text-sm">{message}</p>
  </form>
}

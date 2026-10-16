"use client"

import { useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { cancelEmployeeResearch, prepareEmployee, runEmployeeResearch, saveEmployeeDraft } from "@/app/actions/super-agent"
import { EmployeeResearchResult } from "@/components/gradia/employee-result"
import { EMPLOYEE_TEMPLATES, employeeBriefSchema, type EmployeeBrief, type EmployeeDraft } from "@/lib/super-agent/brief"
import type { SavedResearchRun } from "@/lib/super-agent/research-store"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"

const empty: EmployeeBrief = { name: "", goal: "", deliverable: "", business_context: "", steps: ["Review the goal and identify the information needed."], connections_needed: [], questions: [] }

export function EmployeeBuilder({ drafts, runs, loadFailed, runLoadFailed, planningEnabled, planningCredits, researchEnabled }: {
  drafts: EmployeeDraft[]
  runs: SavedResearchRun[]
  loadFailed: boolean
  runLoadFailed: boolean
  planningEnabled: boolean
  planningCredits: number | null
  researchEnabled: boolean
}) {
  const router = useRouter()
  const [brief, setBrief] = useState<EmployeeBrief>(empty)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const [saveUncertain, setSaveUncertain] = useState(false)
  const [runUncertain, setRunUncertain] = useState(false)
  const [freshRuns, setFreshRuns] = useState<Record<string, SavedResearchRun>>({})
  const [runDraftId, setRunDraftId] = useState<string | null>(null)
  const inFlight = useRef(false)
  const stopSent = useRef(false)
  const command = useRef<{ id: string; brief: EmployeeBrief } | null>(null)
  const runCommand = useRef<{ id: string; draftId: string } | null>(null)
  function change<K extends keyof EmployeeBrief>(key: K, value: EmployeeBrief[K]) {
    setBrief(current => ({ ...current, [key]: value }))
    setMessage("")
  }
  function latestRun(draftId: string) {
    return freshRuns[draftId] ?? runs.find(run => run.draft_id === draftId)
  }
  async function plan() {
    if (inFlight.current || saveUncertain) return
    inFlight.current = true; setBusy(true); setMessage("")
    try {
      const result = await prepareEmployee({ goal: brief.goal, context: brief.business_context })
      if (result.ok) { setBrief(result.brief); setMessage("Your draft brief is ready to review. No work has started.") }
      else setMessage(result.error)
    } catch { setMessage("The setup response was interrupted. No employee job has started.") }
    finally { inFlight.current = false; setBusy(false) }
  }
  async function save() {
    if (inFlight.current) return
    if (!command.current) {
      const checked = employeeBriefSchema.safeParse(brief)
      if (!checked.success) { setMessage("Check the name, goal, output and steps. Use 1–8 non-empty steps, up to 300 characters each."); return }
    }
    inFlight.current = true; setBusy(true); setMessage("")
    command.current ??= { id: crypto.randomUUID(), brief: structuredClone(brief) }
    try {
      const result = await saveEmployeeDraft(command.current)
      if (result.ok) {
        command.current = null; setSaveUncertain(false); setBrief(empty)
        setMessage("Employee brief saved. It is a draft until you run it."); router.refresh()
      } else { setSaveUncertain(true); setMessage(result.error) }
    } catch { setSaveUncertain(true); setMessage("Save could not be confirmed. Retry the same brief or reload to check saved employees.") }
    finally { inFlight.current = false; setBusy(false) }
  }
  async function run(draftId: string) {
    if (inFlight.current || saveUncertain || runLoadFailed) return
    if (runUncertain && runCommand.current?.draftId !== draftId) return
    inFlight.current = true; setBusy(true); setMessage("Checking the public pages in this brief."); stopSent.current = false
    if (!runCommand.current || runCommand.current.draftId !== draftId) runCommand.current = { id: crypto.randomUUID(), draftId }
    const current = runCommand.current
    setRunDraftId(current.draftId)
    try {
      const result = await runEmployeeResearch({ id: current.id, draftId: current.draftId })
      if (result.ok) {
        runCommand.current = null; setRunDraftId(null); setRunUncertain(false)
        setFreshRuns(existing => ({ ...existing, [current.draftId]: result.run }))
        setMessage(result.replayed ? "That run was already saved. Nothing ran again." : "Research saved. This run did not change your accounts.")
        router.refresh()
      } else { setRunUncertain(true); setMessage(result.error) }
    } catch { setRunUncertain(true); setMessage("The run could not be confirmed. Retry this same run or reload saved results.") }
    finally { inFlight.current = false; setBusy(false) }
  }
  async function stop() {
    const current = runCommand.current
    if (!current || stopSent.current) return
    stopSent.current = true
    try {
      const result = await cancelEmployeeResearch({ id: current.id })
      setMessage(result.ok && result.state === "already_finished" ? "This run had already finished." : result.ok ? "Stop requested. Gradia will finish the page already in progress, then save what it has." : result.error)
    } catch { setMessage("Stop could not be confirmed. The run may still finish.") }
  }
  return <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,0.7fr)]">
    <section className="min-w-0 space-y-6 rounded-xl border bg-card p-5 sm:p-7" aria-labelledby="employee-setup">
      <div><h2 id="employee-setup" className="text-xl font-semibold">What would you like help with?</h2><p className="mt-2 text-sm text-muted-foreground">Start with an example or describe your own digital employee.</p></div>
      <div className="flex flex-wrap gap-2">{EMPLOYEE_TEMPLATES.map(template => <Button key={template.name} variant="outline" className="min-h-11 h-auto whitespace-normal" disabled={busy || saveUncertain} onClick={() => { setBrief({ ...empty, name: template.name, goal: template.goal }); setMessage("") }}>{template.name}</Button>)}</div>
      <form onSubmit={event => { event.preventDefault(); void save() }} className="space-y-5">
        <fieldset disabled={busy || saveUncertain} className="space-y-5">
          <label className="block space-y-2"><span className="text-sm font-medium">Give your employee a name</span><Input required minLength={2} maxLength={80} value={brief.name} onChange={event => change("name", event.target.value)} placeholder="My Google helper" /></label>
          <label className="block space-y-2"><span className="text-sm font-medium">What should it do?</span><Textarea required minLength={10} maxLength={2000} rows={4} value={brief.goal} onChange={event => change("goal", event.target.value)} placeholder="Help my detailing business show up on Google and tell me what to improve first." /></label>
          <label className="block space-y-2"><span className="text-sm font-medium">What should it know about your business?</span><Textarea maxLength={3000} rows={3} value={brief.business_context} onChange={event => change("business_context", event.target.value)} placeholder="Your services, area, and public website address starting with https://. Leave out passwords and private customer information." /></label>
          {planningEnabled && <Button type="button" variant="secondary" className="min-h-11" onClick={() => void plan()}>Help me write the brief{planningCredits !== null ? ` · ${planningCredits} credits` : ""}</Button>}
          <label className="block space-y-2"><span className="text-sm font-medium">What should it give you?</span><Textarea required minLength={5} maxLength={600} rows={2} value={brief.deliverable} onChange={event => change("deliverable", event.target.value)} placeholder="A prioritized checklist with evidence and draft improvements for me to review." /></label>
          <label className="block space-y-2"><span className="text-sm font-medium">Steps to follow</span><Textarea required rows={4} maxLength={2400} value={brief.steps.join("\n")} onChange={event => change("steps", event.target.value.split("\n"))} /><span className="block text-xs text-muted-foreground">One step per line, up to eight. You can edit these before saving.</span></label>
        </fieldset>
        {brief.connections_needed.length > 0 && <div><h3 className="font-medium">Connections it would need</h3><ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">{brief.connections_needed.map((item, i) => <li key={i}>{item}</li>)}</ul><p className="mt-2 text-xs text-muted-foreground">These are requested connections, not connected accounts.</p></div>}
        {brief.questions.length > 0 && <div><h3 className="font-medium">Still to clarify</h3><ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">{brief.questions.map((item, i) => <li key={i}>{item}</li>)}</ul></div>}
        <div className="flex flex-wrap gap-3"><Button type="submit" disabled={busy || loadFailed} className="min-h-11">{busy ? "Working…" : saveUncertain ? "Retry same save" : "Save employee brief"}</Button>{saveUncertain && <Button type="button" variant="outline" className="min-h-11" onClick={() => window.location.reload()}>Reload saved employees</Button>}</div>
        <p role="status" aria-live="polite" className="text-sm">{message}</p>
      </form>
    </section>
    <aside className="min-w-0 space-y-5" aria-labelledby="your-employees">
      <div className="rounded-xl border bg-card p-5"><h2 className="font-semibold">You set the job. Gradia does the organizing.</h2><p className="mt-2 text-sm text-muted-foreground">{researchEnabled ? "Run research reads the public pages named in a saved brief and saves the sources. It does not sign in, change accounts, or repeat on a schedule." : "This version saves the job brief. Research runs, website browsing, connected-account actions and scheduled work are not available yet. Saving a brief does not start work."}</p><p className="mt-3 text-sm text-muted-foreground">Your brief stays in this workspace. It does not become a business rule or change the Agent’s permissions.</p></div>
      <h2 id="your-employees" className="text-lg font-semibold">Your employee briefs</h2>
      {loadFailed ? <p role="alert">Saved employees could not be loaded. Refresh before saving a new brief.</p> : null}
      {runLoadFailed ? <p role="alert">Saved research results could not be loaded. Refresh before running research.</p> : null}
      {!loadFailed && drafts.length === 0 ? <p className="text-sm text-muted-foreground">No employee briefs yet. Start with one job you’d like off your plate.</p> : null}
      {drafts.map(draft => {
        const result = latestRun(draft.id)
        const retrying = runUncertain && runDraftId === draft.id
        return <article key={draft.id} className="break-words rounded-xl border bg-card p-5">
          <p className="text-xs font-medium text-muted-foreground">{result ? "BRIEF SAVED" : "DRAFT · NOT RUNNING"}</p>
          <h3 className="mt-2 font-semibold">{draft.brief.name}</h3>
          <p className="mt-2 text-sm">{draft.brief.goal}</p>
          <p className="mt-3 text-sm text-muted-foreground">You’ll receive: {draft.brief.deliverable}</p>
          {researchEnabled && <div className="mt-4 flex flex-wrap gap-2">
            <Button type="button" variant="secondary" className="min-h-11" disabled={loadFailed || runLoadFailed || saveUncertain || (busy && !retrying) || (runUncertain && !retrying)} onClick={() => void run(draft.id)}>{busy && runDraftId === draft.id ? "Running research…" : retrying ? "Retry this same run" : "Run research"}</Button>
            {busy && runDraftId === draft.id && <Button type="button" variant="outline" className="min-h-11" onClick={() => void stop()}>Stop</Button>}
          </div>}
          {researchEnabled && <p className="mt-2 text-xs text-muted-foreground">A run checks public pages only. Other steps in the brief are not performed.</p>}
          {result && <EmployeeResearchResult run={result} />}
        </article>
      })}
      {drafts.length === 50 && <p className="text-xs text-muted-foreground">Showing the 50 most recent briefs.</p>}
    </aside>
  </div>
}

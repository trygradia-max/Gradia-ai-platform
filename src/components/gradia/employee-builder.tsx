"use client"

import { useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { prepareEmployee, saveEmployeeDraft, startResearchRun } from "@/app/actions/super-agent"
import { EMPLOYEE_TEMPLATES, employeeBriefSchema, type EmployeeBrief, type EmployeeDraft } from "@/lib/super-agent/brief"
import type { ResearchReport } from "@/lib/super-agent/research"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"

const empty: EmployeeBrief = { name: "", goal: "", deliverable: "", business_context: "", steps: ["Review the goal and identify the information needed."], connections_needed: [], questions: [] }

export type ResearchRunView = {
  id: string
  draftId: string
  status: "ready" | "blocked"
  report: ResearchReport
}

export function EmployeeBuilder({ drafts, runs, loadFailed, planningEnabled, planningCredits }: {
  drafts: EmployeeDraft[]
  runs: ResearchRunView[]
  loadFailed: boolean
  planningEnabled: boolean
  planningCredits: number | null
}) {
  const router = useRouter()
  const [brief, setBrief] = useState<EmployeeBrief>(empty)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const [uncertain, setUncertain] = useState(false)
  const [savedRuns, setSavedRuns] = useState<Record<string, ResearchRunView>>(() =>
    Object.fromEntries(runs.map((run) => [run.draftId, run]))
  )
  const researchCommands = useRef<Record<string, string>>({})
  const inFlight = useRef(false)
  const command = useRef<{ id: string; brief: EmployeeBrief } | null>(null)
  function change<K extends keyof EmployeeBrief>(key: K, value: EmployeeBrief[K]) {
    setBrief(current => ({ ...current, [key]: value }))
    setMessage("")
  }
  async function plan() {
    if (inFlight.current || uncertain) return
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
        command.current = null; setUncertain(false); setBrief(empty)
        setMessage("Employee brief saved. It is a draft, not a running employee."); router.refresh()
      } else { setUncertain(true); setMessage(result.error) }
    } catch { setUncertain(true); setMessage("Save could not be confirmed. Retry the same brief or reload to check saved employees.") }
    finally { inFlight.current = false; setBusy(false) }
  }
  async function research(draftId: string) {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setMessage("")
    researchCommands.current[draftId] ??= crypto.randomUUID()
    try {
      const result = await startResearchRun({ id: researchCommands.current[draftId], draftId })
      if (result.ok) {
        setSavedRuns((current) => ({ ...current, [draftId]: result.run }))
        setMessage(result.run.status === "ready"
          ? "Research is ready for your review. Nothing was published or sent."
          : "Research stopped. A connection is missing, or no usable source was available.")
      } else setMessage(result.error)
    } catch {
      setMessage("Research could not be confirmed. Use Run research again to retry the same pass.")
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }
  return <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,0.65fr)]">
    <section className="min-w-0 space-y-6 rounded-xl border bg-card p-5 sm:p-7" aria-labelledby="employee-setup">
      <div><h2 id="employee-setup" className="text-xl font-semibold">What would you like help with?</h2><p className="mt-2 text-sm text-muted-foreground">Start with an example or describe your own digital employee.</p></div>
      <div className="flex flex-wrap gap-2">{EMPLOYEE_TEMPLATES.map(template => <Button key={template.name} variant="outline" className="min-h-11 h-auto whitespace-normal" disabled={busy || uncertain} onClick={() => { setBrief({ ...empty, name: template.name, goal: template.goal }); setMessage("") }}>{template.name}</Button>)}</div>
      <form onSubmit={event => { event.preventDefault(); void save() }} className="space-y-5">
        <fieldset disabled={busy || uncertain} className="space-y-5">
          <label className="block space-y-2"><span className="text-sm font-medium">Give your employee a name</span><Input required minLength={2} maxLength={80} value={brief.name} onChange={event => change("name", event.target.value)} placeholder="My Google helper" /></label>
          <label className="block space-y-2"><span className="text-sm font-medium">What should it do?</span><Textarea required minLength={10} maxLength={2000} rows={4} value={brief.goal} onChange={event => change("goal", event.target.value)} placeholder="Help my detailing business show up on Google and tell me what to improve first." /></label>
          <label className="block space-y-2"><span className="text-sm font-medium">What should it know about your business?</span><Textarea maxLength={3000} rows={3} value={brief.business_context} onChange={event => change("business_context", event.target.value)} placeholder="Your services, area, website, audience and priorities. Leave out passwords and private customer information." /></label>
          {planningEnabled && <Button type="button" variant="secondary" className="min-h-11" onClick={() => void plan()}>Help me write the brief{planningCredits !== null ? ` · ${planningCredits} credits` : ""}</Button>}
          <label className="block space-y-2"><span className="text-sm font-medium">What should it give you?</span><Textarea required minLength={5} maxLength={600} rows={2} value={brief.deliverable} onChange={event => change("deliverable", event.target.value)} placeholder="A prioritized checklist with evidence and draft improvements for me to review." /></label>
          <label className="block space-y-2"><span className="text-sm font-medium">Steps to follow</span><Textarea required rows={4} maxLength={2400} value={brief.steps.join("\n")} onChange={event => change("steps", event.target.value.split("\n"))} /><span className="block text-xs text-muted-foreground">One step per line, up to eight. You can edit these before saving.</span></label>
        </fieldset>
        {brief.connections_needed.length > 0 && <div><h3 className="font-medium">Connections it would need</h3><ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">{brief.connections_needed.map((item, i) => <li key={i}>{item}</li>)}</ul><p className="mt-2 text-xs text-muted-foreground">These are requested connections, not connected accounts.</p></div>}
        {brief.questions.length > 0 && <div><h3 className="font-medium">Still to clarify</h3><ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">{brief.questions.map((item, i) => <li key={i}>{item}</li>)}</ul></div>}
        <div className="flex flex-wrap gap-3"><Button type="submit" disabled={busy || loadFailed} className="min-h-11">{busy ? "Working…" : uncertain ? "Retry same save" : "Save employee brief"}</Button>{uncertain && <Button type="button" variant="outline" className="min-h-11" onClick={() => window.location.reload()}>Reload saved employees</Button>}</div>
        <p role="status" aria-live="polite" className="text-sm">{message}</p>
      </form>
    </section>
    <aside className="min-w-0 space-y-5" aria-labelledby="your-employees">
      <div className="rounded-xl border bg-card p-5"><h2 className="font-semibold">You set the job. Gradia does the organizing.</h2><p className="mt-2 text-sm text-muted-foreground">A saved brief can run one research pass from starter sources. It does not browse the web, send messages, or change accounts.</p><p className="mt-3 text-sm text-muted-foreground">The report waits for your review. It does not become a business rule or a permission.</p></div>
      <h2 id="your-employees" className="text-lg font-semibold">Your employee briefs</h2>
      {loadFailed ? <p role="alert">Saved employees could not be loaded. Refresh before saving a new brief.</p> : drafts.length === 0 ? <p className="text-sm text-muted-foreground">No employee briefs yet. Start with one job you’d like off your plate.</p> : drafts.map(draft => {
        const run = savedRuns[draft.id]
        return <article key={draft.id} className="break-words rounded-xl border bg-card p-5"><p className="text-xs font-medium text-muted-foreground">{run ? (run.status === "ready" ? "READY FOR REVIEW" : "BLOCKED") : "DRAFT · NOT RUNNING"}</p><h3 className="mt-2 font-semibold">{draft.brief.name}</h3><p className="mt-2 text-sm">{draft.brief.goal}</p><p className="mt-3 text-sm text-muted-foreground">You’ll receive: {draft.brief.deliverable}</p><Button type="button" variant="outline" className="mt-4 min-h-11" disabled={busy || loadFailed} onClick={() => void research(draft.id)}>Run research</Button>{run ? <div className="mt-4 space-y-2 text-sm"><p className="font-medium">Approval status: waiting for your review</p><p>{run.report.summary}</p>{run.report.findings.map((finding) => <p key={finding.source_title}>{finding.claim} Source: {finding.source_title}</p>)}{run.report.missing_connections.length > 0 ? <p>Needs a connection: {run.report.missing_connections.join(", ")}</p> : null}</div> : null}</article>
      })}
      {drafts.length === 50 && <p className="text-xs text-muted-foreground">Showing the 50 most recent briefs.</p>}
    </aside>
  </div>
}

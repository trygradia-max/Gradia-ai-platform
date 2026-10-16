import { AlertTriangle, CheckCircle2, MinusCircle } from "lucide-react"
import { StatusPill, type StatusPillTone } from "@/components/ui/status-pill"
import { safePublicHref } from "@/lib/super-agent/public-href"
import type { SavedResearchStatus } from "@/lib/super-agent/research"
import type { SavedResearchRun } from "@/lib/super-agent/research-store"

const STATUS: Record<SavedResearchStatus, { tone: StatusPillTone; label: string; detail: string; icon: "good" | "warn" | "muted" }> = {
  completed: { tone: "good", label: "Saved result", detail: "This run finished and the result is saved.", icon: "good" },
  cancelled: { tone: "muted", label: "Stopped", detail: "You stopped this run. The finished checks are saved.", icon: "muted" },
  timed_out: { tone: "warn", label: "Time limit", detail: "The run stopped at the time limit. Finished checks are saved.", icon: "warn" },
  budget_exhausted: { tone: "warn", label: "Page limit", detail: "The run stopped at the page limit. Finished checks are saved.", icon: "warn" },
  failed: { tone: "bad", label: "Not finished", detail: "Gradia could not fetch the pages. Nothing was invented in their place.", icon: "warn" },
}

const UNAVAILABLE = [
  "Google rankings are not connected.",
  "Google Business Profile is not connected.",
  "A cloud browser is not connected. JavaScript on the page was not run.",
  "This run is not on a schedule.",
]

function StatusIcon({ kind }: { kind: "good" | "warn" | "muted" }) {
  if (kind === "good") return <CheckCircle2 className="size-3" aria-hidden />
  if (kind === "warn") return <AlertTriangle className="size-3" aria-hidden />
  return <MinusCircle className="size-3" aria-hidden />
}

export function EmployeeResearchResult({ run }: { run: SavedResearchRun }) {
  const status = STATUS[run.status]
  return <section className="mt-4 space-y-4 border-t pt-4" aria-label={`${run.report.mode === "seo" ? "SEO" : "Source"} research result`}>
    <div className="space-y-2">
      <StatusPill tone={status.tone} icon={<StatusIcon kind={status.icon} />}>{status.label}</StatusPill>
      <p className="text-sm">{status.detail}</p>
      <p className="text-sm">{run.report.summary}</p>
      <p className="text-xs text-muted-foreground">Credits used <span className="font-data">{run.credits}</span></p>
    </div>
    {run.report.findings.length > 0 && <div>
      <h4 className="text-sm font-medium">Findings</h4>
      <ul className="mt-2 space-y-3">
        {run.report.findings.map((item, index) => <li key={index} className="text-sm">
          <p>{item.kind === "recommendation" ? "Suggestion: " : ""}{item.statement}</p>
          <p className="text-xs text-muted-foreground">Evidence: {item.evidence}</p>
        </li>)}
      </ul>
    </div>}
    <div>
      <h4 className="text-sm font-medium">Sources</h4>
      {run.report.sources.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">No page was fetched.</p> : <ul className="mt-2 space-y-3">
        {run.report.sources.map(source => {
          const href = source.status === "fetched" ? safePublicHref(source.final_url) : null
          return <li key={`${source.url}-${source.status}`} className="break-words text-sm">
            <p>{href ? <a className="underline underline-offset-4" href={href} target="_blank" rel="noreferrer noopener">{source.final_url}</a> : source.final_url}</p>
            <p className="text-xs text-muted-foreground">{source.status === "fetched" ? "Fetched" : source.status === "blocked" ? "Blocked" : source.status === "skipped" ? "Skipped" : "Not fetched"}{source.http_status ? <> · <span className="font-data">{source.http_status}</span></> : null}{source.ignored_page_instructions ? " · Page instructions ignored" : ""}</p>
            <p className="text-xs text-muted-foreground">{source.excerpt}</p>
          </li>
        })}
      </ul>}
    </div>
    <div>
      <h4 className="text-sm font-medium">Not used</h4>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">{UNAVAILABLE.map(item => <li key={item}>{item}</li>)}</ul>
    </div>
    {run.report.uncertainties.length > 0 && <div>
      <h4 className="text-sm font-medium">Limits</h4>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">{run.report.uncertainties.map(item => <li key={item}>{item}</li>)}</ul>
    </div>}
  </section>
}

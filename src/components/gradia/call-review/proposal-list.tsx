"use client"

import { useMemo, useState, useTransition } from "react"

import { approveCallProposal, approveSelectedCallProposals, dismissCallProposal } from "@/app/actions/call-copilot-review"
import { Button } from "@/components/ui/button"
import type { ReviewProposal } from "@/lib/call-copilot/review-dto"
import { canApprove, groupBySet, planSelection, selectionRefusalCopy } from "@/lib/call-copilot/review-model"
import type { DecideResult, StepOutcome } from "@/lib/call-review/decide"
import { STRINGS } from "@/lib/strings"
import { cn } from "@/lib/utils"

import { ProposalCard, type CardResult } from "./proposal-card"

const toCard = (s: StepOutcome): CardResult => {
  switch (s.result) {
    case "approved": return { tone: "good", message: s.message }
    case "dismissed": return { tone: "good", message: s.message }
    case "already_decided": return { tone: "warn", message: s.message }
    case "unconfirmed": return { tone: "warn", message: `${s.message}` }
    default: return { tone: "bad", message: s.message }
  }
}

/**
 * The interactive part of the review: selection, single approve, approve-selected and dismiss. It holds NO authority.
 * It sends references (call id, proposal id, the review token it was shown) to the server actions, never a shop, an
 * action id or a payload, and it reports only what the server returns: nothing is shown as done before the executor's
 * answer, and the page then re-renders from a fresh read.
 */
export function ProposalList({
  callId, proposals, viewerCanApprove, snippetsWithheld,
}: {
  callId: string
  proposals: ReviewProposal[]
  viewerCanApprove: boolean
  snippetsWithheld: boolean
}) {
  const s = STRINGS.pages.callReview
  const [pending, startTransition] = useTransition()
  const [busyId, setBusyId] = useState<string | "bulk" | null>(null)
  const [chosen, setChosen] = useState<Record<string, string>>({})
  const [results, setResults] = useState<Record<string, CardResult>>({})
  const [banner, setBanner] = useState<{ ok: boolean; message: string } | null>(null)

  // A selection is only valid while the proposal is still ready AND is still exactly what was selected.
  const selection = useMemo(
    () => proposals.filter((p) => chosen[p.id] === p.review_token && canApprove(p, proposals, viewerCanApprove))
      .map((p) => ({ proposalId: p.id, reviewToken: p.review_token })),
    [chosen, proposals, viewerCanApprove],
  )
  const plan = selection.length ? planSelection({ proposals }, selection) : null
  const refusal = plan && !plan.ok ? selectionRefusalCopy(plan) : null

  const apply = (r: DecideResult) => {
    setBanner({ ok: r.ok, message: r.message })
    const next: Record<string, CardResult> = {}
    for (const step of r.steps) next[step.proposalId] = toCard(step)
    for (const id of r.notAttempted) next[id] = { tone: "warn", message: "Not attempted because an earlier step did not go through." }
    setResults((cur) => ({ ...cur, ...next }))
    setChosen({})
    setBusyId(null)
  }

  const run = (id: string | "bulk", fn: () => Promise<DecideResult>) => {
    setBanner(null)
    setBusyId(id)
    startTransition(async () => {
      try {
        apply(await fn())
      } catch {
        setBusyId(null)
        setBanner({ ok: false, message: "That did not finish and its result is not known. Refresh and check the proposal before trying again." })
      }
    })
  }

  const sets = groupBySet(proposals)
  const anyBusy = pending || busyId !== null
  return (
    <div className="space-y-6">
      <div aria-live="polite" className="space-y-2">
        {banner ? (
          <p role={banner.ok ? "status" : "alert"} className={cn("rounded-sm px-3 py-2 text-sm", banner.ok ? "bg-status-success-bg text-status-success-fg" : "bg-status-warning-bg text-status-warning-fg")}>
            <span className="font-medium">{s.resultHeading}: </span>{banner.message}
          </p>
        ) : null}
        {anyBusy ? <p className="text-sm text-muted-foreground">{busyId === "bulk" ? s.approvingSelected : s.refreshing}</p> : null}
      </div>

      {sets.map((set, index) => (
        <div key={set.setId} className="space-y-4">
          {sets.length > 1 ? (
            <h3 className="label-eyebrow text-muted-foreground">{set.mine ? "Prepared by you" : "Prepared by a team member"} · set {index + 1}</h3>
          ) : null}
          <ul className="space-y-4">
            {set.proposals.map((p) => (
              <li key={p.id}>
                <ProposalCard
                  proposal={p}
                  all={proposals}
                  viewerCanApprove={viewerCanApprove}
                  snippetsWithheld={snippetsWithheld}
                  selected={chosen[p.id] === p.review_token}
                  busy={busyId === p.id}
                  anyBusy={anyBusy}
                  result={results[p.id] ?? null}
                  onToggle={(x) => setChosen((c) => { const n = { ...c }; if (n[x.id]) delete n[x.id]; else n[x.id] = x.review_token; return n })}
                  onApprove={(x) => run(x.id, () => approveCallProposal({ callId, proposalId: x.id, reviewToken: x.review_token }))}
                  onDismiss={(x) => run(x.id, () => dismissCallProposal({ callId, proposalId: x.id, reviewToken: x.review_token }))}
                />
              </li>
            ))}
          </ul>
        </div>
      ))}

      {viewerCanApprove && proposals.some((p) => canApprove(p, proposals, true)) ? (
        <div className="sticky bottom-3 z-10 space-y-2 rounded-md bg-card p-4 shadow-lg ring-1 ring-border">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button" className="min-h-11" aria-busy={busyId === "bulk"}
              disabled={anyBusy || selection.length === 0 || refusal !== null}
              onClick={() => run("bulk", () => approveSelectedCallProposals({ callId, items: selection }))}
            >
              {busyId === "bulk" ? s.approvingSelected : s.approveSelected(selection.length)}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{refusal ?? s.selectionHint}</p>
          <p className="text-xs text-muted-foreground">{s.ranNote}</p>
        </div>
      ) : null}
    </div>
  )
}

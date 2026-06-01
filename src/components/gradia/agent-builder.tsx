"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import {
  Clock,
  Loader2,
  Send,
  Sparkles,
  Target,
  TriangleAlert,
  Users,
  Wand2,
} from "lucide-react"
import { toast } from "sonner"

import {
  planAgent,
  previewCustomAgentPlan,
  saveCustomAgent,
} from "@/app/actions/custom-agents"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { StatusPill } from "@/components/ui/status-pill"
import { Textarea } from "@/components/ui/textarea"
import type { FreeformPreview } from "@/lib/agent-audience"
import type { AgentConfig } from "@/lib/types/database"

const EXAMPLES = [
  "Follow up with customers whose quote is 7 days old and we haven't heard back from them.",
  "Every Monday morning, draft a note about how many leads came in last week and where they came from.",
  "When a booking is created for tomorrow, draft an email reminder with directions to the shop.",
  "If a customer paid an invoice over $500, send them a thank-you text the next day asking for a review.",
]

const ACTION_LABEL: Record<AgentConfig["action"]["kind"], string> = {
  draft_sms: "Draft an SMS for our approval",
  draft_email: "Draft an email for our approval",
  log_note: "Log a note in our memory",
  flag_for_review: "Flag it for us to review",
}

export function AgentBuilder() {
  const router = useRouter()
  const [problem, setProblem] = React.useState("")
  const [planning, setPlanning] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [plan, setPlan] = React.useState<AgentConfig | null>(null)
  const [preview, setPreview] = React.useState<FreeformPreview | null>(null)
  const [previewing, setPreviewing] = React.useState(false)

  async function handlePlan(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!problem.trim() || planning) return
    setPlanning(true)
    setPlan(null)
    setPreview(null)
    const result = await planAgent(problem)
    setPlanning(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setPlan(result.config)
  }

  async function handleSave() {
    if (!plan || saving) return
    setSaving(true)
    const result = await saveCustomAgent({
      problem_text: problem,
      config: plan,
    })
    setSaving(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(`Saved — "${result.agent.name}" is on /agents.`)
    router.push("/agents")
  }

  async function handlePreview() {
    if (!plan?.freeform || previewing) return
    setPreviewing(true)
    const result = await previewCustomAgentPlan(plan)
    setPreviewing(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setPreview(result.preview)
    if (result.preview.blocked) toast.error(result.preview.blocked)
  }

  function handleExample(text: string) {
    if (planning) return
    setProblem(text)
    setPlan(null)
    setPreview(null)
  }

  function handleReset() {
    setPlan(null)
    setPreview(null)
  }

  return (
    <div className="grid gap-6">
      <Card className="border-border/80">
        <CardHeader className="flex flex-row items-center gap-3 space-y-0">
          <div className="flex size-10 items-center justify-center rounded-lg bg-primary/15 text-primary ring-1 ring-primary/30">
            <Wand2 className="size-5" aria-hidden />
          </div>
          <div>
            <CardTitle className="text-base font-medium">
              Describe what you want us to do
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Plain English is fine. We&apos;ll draft a workflow you can
              tweak and save.
            </p>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4">
          <form className="grid gap-3" onSubmit={handlePlan}>
            <Label htmlFor="problem">The problem</Label>
            <Textarea
              id="problem"
              value={problem}
              onChange={(e) => {
                setProblem(e.target.value)
                if (plan) setPlan(null)
                if (preview) setPreview(null)
              }}
              placeholder={EXAMPLES[0]}
              rows={5}
              maxLength={2000}
              disabled={planning}
            />
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
              <p className="text-xs text-muted-foreground sm:order-1">
                {problem.length} / 2000
              </p>
              <Button
                type="submit"
                disabled={planning || !problem.trim()}
                className="h-11 gap-2 sm:order-2 sm:h-9"
              >
                {planning ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <Sparkles className="size-4" aria-hidden />
                )}
                {planning ? "Planning…" : "Plan this"}
              </Button>
            </div>
          </form>

          {!plan && !planning ? (
            <div className="flex flex-wrap gap-2 pt-2">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => handleExample(ex)}
                  className="rounded-full border border-border/60 bg-muted/30 px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  {ex}
                </button>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {plan ? (
        <Card className="border-primary/30">
          <CardHeader className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-lg font-semibold tracking-tight">
                {plan.name}
              </CardTitle>
              <StatusPill tone="warn">Review before saving</StatusPill>
            </div>
            <p className="text-sm text-muted-foreground">
              {plan.short_description}
            </p>
          </CardHeader>
          <CardContent className="grid gap-5">
            <div className="grid gap-2">
              <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-widest text-muted-foreground">
                <Clock className="size-3.5" aria-hidden />
                When it runs
              </div>
              <p className="text-sm">
                {plan.trigger.kind === "schedule"
                  ? plan.trigger.schedule_summary || "On a schedule"
                  : plan.trigger.event_summary || "When something happens"}
              </p>
            </div>

            <div className="grid gap-2">
              <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-widest text-muted-foreground">
                <Target className="size-3.5" aria-hidden />
                Who it acts on
              </div>
              <p className="text-sm capitalize">{plan.audience.entity}</p>
              <ul className="grid gap-1 text-sm text-muted-foreground">
                {plan.audience.filters_summary.map((f, i) => (
                  <li key={i}>• {f}</li>
                ))}
              </ul>
            </div>

            <div className="grid gap-2">
              <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-widest text-muted-foreground">
                <Send className="size-3.5" aria-hidden />
                What it does
              </div>
              <p className="text-sm">
                <span className="font-medium">
                  {ACTION_LABEL[plan.action.kind]}
                </span>{" "}
                — {plan.action.intent_summary}
              </p>
            </div>

            {plan.prerequisites_needed.length > 0 ? (
              <div className="grid gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2.5">
                <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-widest text-amber-700 dark:text-amber-400">
                  <TriangleAlert className="size-3.5" aria-hidden />
                  Needs
                </div>
                <ul className="grid gap-1 text-sm">
                  {plan.prerequisites_needed.map((p, i) => (
                    <li key={i}>• {p}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {plan.freeform ? (
              <div className="grid gap-3 rounded-md border border-border/60 bg-muted/20 px-3 py-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-widest text-muted-foreground">
                    <Users className="size-3.5" aria-hidden />
                    Dry run
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handlePreview}
                    disabled={previewing}
                    className="h-8 gap-2"
                  >
                    {previewing ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden />
                    ) : null}
                    {preview ? "Refresh preview" : "Preview audience"}
                  </Button>
                </div>
                {preview && !preview.blocked ? (
                  <div className="grid gap-3">
                    <p className="text-sm">
                      <span className="font-medium">{preview.count}</span>{" "}
                      {preview.count === 1 ? "recipient" : "recipients"} match
                      right now — each becomes an approval. Nothing sends
                      automatically.
                    </p>
                    {preview.samples.length > 0 ? (
                      <ul className="grid gap-2">
                        {preview.samples.map((s, i) => (
                          <li
                            key={i}
                            className="rounded border border-border/50 bg-background/60 px-3 py-2 text-sm"
                          >
                            <div className="text-xs text-muted-foreground">
                              {s.name ? `${s.name} · ` : ""}
                              {s.to}
                            </div>
                            {s.subject ? (
                              <div className="font-medium">{s.subject}</div>
                            ) : null}
                            <div className="text-muted-foreground">
                              {s.message}
                            </div>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        No sample drafts — likely no one matches yet.
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Preview who this reaches and see a few sample drafts before
                    you enable it.
                  </p>
                )}
              </div>
            ) : null}

            <p className="text-xs text-muted-foreground">
              {plan.human_in_the_loop_note}
            </p>

            <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
              <Button
                type="button"
                variant="ghost"
                onClick={handleReset}
                disabled={saving}
                className="h-11 sm:h-9"
              >
                Revise
              </Button>
              <Button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="h-11 gap-2 sm:h-9"
              >
                {saving ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : null}
                Save this agent
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}

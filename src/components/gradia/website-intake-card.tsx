"use client"

import * as React from "react"

import {
  configurePublicIntakeForm,
} from "@/app/actions/public-intake-forms"
import { HelpTip } from "@/components/gradia/help-tip"
import { STRINGS } from "@/lib/strings"
import type { publicFormResultSchema } from "@/lib/public-form-intake"
import { useRouter } from "next/navigation"
import { Globe, Loader2 } from "lucide-react"
import { toast } from "sonner"
import type { z } from "zod"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { StatusPill } from "@/components/ui/status-pill"
import { MotionCard } from "@/components/gradia/motion/motion-card"

type PublicForm = z.infer<typeof publicFormResultSchema>

export type WebsiteIntakeInitial =
  | { ok: true; forms: PublicForm[] }
  | { ok: false }

export type WebsiteIntakeCommand = {
  formId: string
  origin: string
  enabled: boolean
  revision: number
}

/** New forms always start disabled at revision 0 with a fresh id. */
export function websiteIntakeCreateCommand(origin: string): WebsiteIntakeCommand {
  return {
    formId: crypto.randomUUID(),
    origin: origin.trim(),
    enabled: false,
    revision: 0,
  }
}

/** Edits carry the revision the owner was shown; enabling stays explicit. */
export function websiteIntakeUpdateCommand(
  form: PublicForm,
  patch: { origin?: string; enabled?: boolean },
): WebsiteIntakeCommand {
  return {
    formId: form.id,
    origin: (patch.origin ?? form.allowed_origin).trim(),
    enabled: patch.enabled ?? form.enabled,
    revision: form.revision,
  }
}

/**
 * Owner-only website-intake setup (C1). Lists configured public forms with
 * their exact HTTPS origin, enabled state and revision, and sends explicit
 * create / edit-origin / enable / disable commands through the existing
 * `configurePublicIntakeForm` action. New forms start disabled; enabling is
 * always a separate explicit action.
 *
 * A failed or uncertain save never retries on its own: the list is refreshed
 * first and the owner re-applies the change against the current revision.
 * Nothing here infers consent, customer identity, or channel readiness —
 * submissions land in intake identity review as unverified text.
 */
export function WebsiteIntakeCard({
  shopId,
  initial,
}: {
  shopId: string
  initial: WebsiteIntakeInitial
}) {
  const router = useRouter()
  const [pending, setPending] = React.useState<string | null>(null)
  const [problem, setProblem] = React.useState<string | null>(null)
  const [newOrigin, setNewOrigin] = React.useState("")
  const [drafts, setDrafts] = React.useState<Record<string, string>>({})
  const [editing, setEditing] = React.useState<string | null>(null)

  if (!initial.ok) {
    return (
      <MotionCard interactive={false} className="space-y-4 p-6">
        <div className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20">
            <Globe className="size-4" aria-hidden />
          </div>
          <div className="space-y-1">
            <p className="flex items-center gap-1.5 font-medium text-foreground">
              Website intake
              <HelpTip label="Website intake" text={STRINGS.help.settings.websiteIntake} />
            </p>
            <p className="max-w-prose text-sm text-muted-foreground">
              Website forms are unavailable. Owner access is required — refresh,
              and check that your login still owns this shop. Nothing was changed.
            </p>
          </div>
        </div>
      </MotionCard>
    )
  }

  const forms = initial.forms

  async function run(label: string, command: { formId: string; origin: string; enabled: boolean; revision: number }) {
    setPending(label)
    setProblem(null)
    let result: Awaited<ReturnType<typeof configurePublicIntakeForm>>
    try {
      result = await configurePublicIntakeForm({ shopId, ...command })
    } catch {
      result = { ok: false as const, message: "Configuration could not be confirmed. Refresh before retrying." }
    }
    setPending(null)
    // Fresh list before any further command — a stale revision, an error, or
    // an uncertain outcome all require re-reading current configuration first.
    router.refresh()
    if (!result.ok) {
      setProblem(`${result.message} The list was refreshed — review the current revision before trying again.`)
      return
    }
    if (editing === command.formId) {
      setEditing(null)
      setDrafts((prev) => {
        const next = { ...prev }
        delete next[command.formId]
        return next
      })
    }
    toast.success(command.enabled ? "Form saved." : "Form saved as disabled.")
  }

  function create() {
    const origin = newOrigin.trim()
    if (!origin) {
      setProblem("Enter the exact HTTPS origin your website is served from, without a path or trailing slash.")
      return
    }
    void run(`create:${origin}`, websiteIntakeCreateCommand(origin))
  }

  return (
    <MotionCard interactive={false} className="space-y-4 p-6">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20">
          <Globe className="size-4" aria-hidden />
        </div>
        <div className="space-y-1">
          <p className="flex items-center gap-1.5 font-medium text-foreground">
            Website intake
            <HelpTip label="Website intake" text={STRINGS.help.settings.websiteIntake} />
          </p>
          <p className="max-w-prose text-sm text-muted-foreground">
            Let your website send inquiries into intake review. Each form accepts
            submissions only from its exact configured origin. Submissions land
            in identity review as unverified text — a phone number or email is
            not consent and not proof of identity.
          </p>
        </div>
      </div>

      {problem ? (
        <p role="alert" className="max-w-prose rounded-md bg-status-danger-bg px-4 py-3 text-sm text-status-danger-fg">
          {problem}
        </p>
      ) : null}

      {forms.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No website forms yet. Add the exact origin below — new forms start disabled.
        </p>
      ) : (
        <ul className="space-y-3">
          {forms.map((form) => {
            const isEditing = editing === form.id
            const draft = drafts[form.id] ?? form.allowed_origin
            return (
              <li
                key={form.id}
                className="space-y-2 rounded-md bg-raised px-4 py-3 ring-1 ring-border"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill tone={form.enabled ? "good" : "muted"}>
                    {form.enabled ? "Enabled" : "Disabled"}
                  </StatusPill>
                  <span className="text-xs text-muted-foreground">
                    Revision {form.revision}
                  </span>
                </div>
                {isEditing ? (
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <div className="flex-1 space-y-1">
                      <Label htmlFor={`website-origin-${form.id}`}>Exact HTTPS origin</Label>
                      <Input
                        id={`website-origin-${form.id}`}
                        type="url"
                        inputMode="url"
                        placeholder="https://www.example.com"
                        value={draft}
                        onChange={(e) =>
                          setDrafts((prev) => ({ ...prev, [form.id]: e.target.value }))
                        }
                        disabled={pending !== null}
                      />
                    </div>
                    <div className="flex items-end gap-2">
                      <Button
                        type="button"
                        disabled={pending !== null || !draft.trim()}
                        onClick={() =>
                          void run(
                            `save:${form.id}`,
                            websiteIntakeUpdateCommand(form, { origin: draft }),
                          )
                        }
                        className="h-10 gap-2"
                      >
                        {pending === `save:${form.id}` ? (
                          <Loader2 className="size-4 animate-spin" aria-hidden />
                        ) : null}
                        Save
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={pending !== null}
                        onClick={() => {
                          setEditing(null)
                          setDrafts((prev) => {
                            const next = { ...prev }
                            delete next[form.id]
                            return next
                          })
                        }}
                        className="h-10"
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="break-all font-data text-sm text-foreground">
                      {form.allowed_origin}
                    </p>
                    <p className="break-all text-xs text-muted-foreground">
                      Submissions endpoint: POST /api/intake/public-form/{form.id}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        disabled={pending !== null}
                        onClick={() => {
                          setEditing(form.id)
                          setProblem(null)
                        }}
                        className="h-10"
                      >
                        Edit origin
                      </Button>
                      {form.enabled ? (
                        <Button
                          type="button"
                          variant="outline"
                          disabled={pending !== null}
                          onClick={() =>
                            void run(
                              `disable:${form.id}`,
                              websiteIntakeUpdateCommand(form, { enabled: false }),
                            )
                          }
                          className="h-10 gap-2"
                        >
                          {pending === `disable:${form.id}` ? (
                            <Loader2 className="size-4 animate-spin" aria-hidden />
                          ) : null}
                          Disable
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          disabled={pending !== null}
                          onClick={() =>
                            void run(
                              `enable:${form.id}`,
                              websiteIntakeUpdateCommand(form, { enabled: true }),
                            )
                          }
                          className="h-10 gap-2"
                        >
                          {pending === `enable:${form.id}` ? (
                            <Loader2 className="size-4 animate-spin" aria-hidden />
                          ) : null}
                          Enable
                        </Button>
                      )}
                    </div>
                  </>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <div className="flex flex-col gap-2 border-t border-border pt-4 sm:flex-row">
        <div className="flex-1 space-y-1">
          <Label htmlFor="website-intake-new-origin">New form origin</Label>
          <Input
            id="website-intake-new-origin"
            type="url"
            inputMode="url"
            placeholder="https://www.example.com"
            value={newOrigin}
            onChange={(e) => setNewOrigin(e.target.value)}
            disabled={pending !== null}
          />
        </div>
        <div className="flex items-end">
          <Button
            type="button"
            onClick={create}
            disabled={pending !== null || !newOrigin.trim()}
            className="h-10 gap-2"
          >
            {pending?.startsWith("create:") ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : null}
            Add form (starts disabled)
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        New forms always start disabled. Enabling is a separate explicit action
        after you confirm the exact origin.
      </p>
    </MotionCard>
  )
}

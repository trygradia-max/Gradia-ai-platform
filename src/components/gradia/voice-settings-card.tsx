"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import {
  AnimatePresence,
  motion,
  useReducedMotion,
} from "framer-motion"
import {
  Check,
  ChevronDown,
  Loader2,
  Mic,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react"
import { toast } from "sonner"

import { saveVapiAssistantId } from "@/app/actions/shop"
import {
  buildVapiAssistant,
  deleteVapiAssistant,
  rebuildVapiAssistant,
} from "@/app/actions/vapi-provision"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { useConfirm } from "@/components/ui/confirm-dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { StatusPill } from "@/components/ui/status-pill"
import { Textarea } from "@/components/ui/textarea"
import { EASE_OUT_EXPO } from "@/components/gradia/motion/page-stagger"
import { cn } from "@/lib/utils"

type VoiceOption = {
  id: "warm-female" | "professional-female" | "warm-male" | "neutral-male"
  label: string
  description: string
}

type ToneOption = "warm" | "professional" | "playful"

const VOICE_OPTIONS: VoiceOption[] = [
  {
    id: "warm-female",
    label: "Warm female",
    description: "Friendly Northeastern receptionist voice — good default.",
  },
  {
    id: "professional-female",
    label: "Professional female",
    description: "Crisp and confident — great for premium service shops.",
  },
  {
    id: "warm-male",
    label: "Warm male",
    description: "Calm, attentive — reads as a thoughtful service advisor.",
  },
  {
    id: "neutral-male",
    label: "Neutral male",
    description: "Even-toned and direct — minimal personality coloring.",
  },
]

const TONE_OPTIONS: { id: ToneOption; label: string; description: string }[] = [
  {
    id: "warm",
    label: "Warm",
    description: "Like a real teammate. Default.",
  },
  {
    id: "professional",
    label: "Professional",
    description: "Crisp service-advisor energy.",
  },
  {
    id: "playful",
    label: "Playful",
    description: "Lighter touch, still helpful.",
  },
]

export function VoiceSettingsCard({
  initialAssistantId,
  webhookUrl,
  webhookSecretConfigured,
  shopName,
  vapiConfigured,
}: {
  initialAssistantId: string | null
  webhookUrl: string
  webhookSecretConfigured: boolean
  /** Used to seed the greeting placeholder if the operator opens the build form. */
  shopName?: string | null
  /** Set when VAPI_API_KEY is present in env — the build-flow CTAs gate on this. */
  vapiConfigured: boolean
}) {
  const router = useRouter()
  const reduce = useReducedMotion()
  const { confirm, dialog: confirmDialog } = useConfirm()

  const [savedId, setSavedId] = React.useState(initialAssistantId ?? "")
  const [mode, setMode] = React.useState<"summary" | "building">("summary")
  const [pasteId, setPasteId] = React.useState("")
  const [showAdvanced, setShowAdvanced] = React.useState(false)
  const [pending, setPending] = React.useState<
    null | "build" | "rebuild" | "delete" | "save_paste"
  >(null)

  // Build form state
  const defaultGreeting = `Thanks for calling ${shopName?.trim() || "the shop"} — what can we do for you?`
  const [voice, setVoice] = React.useState<VoiceOption["id"]>("warm-female")
  const [tone, setTone] = React.useState<ToneOption>("warm")
  const [greeting, setGreeting] = React.useState("")

  const isConnected = savedId.trim().length > 0

  async function handleBuild() {
    setPending("build")
    const result = await buildVapiAssistant({
      voice,
      tone,
      greeting: greeting.trim() || null,
    })
    setPending(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setSavedId(result.assistantId)
    setMode("summary")
    toast.success("Voice receptionist built — ready to take calls.")
    router.refresh()
  }

  async function handleRebuild() {
    setPending("rebuild")
    const result = await rebuildVapiAssistant({
      voice,
      tone,
      greeting: greeting.trim() || null,
    })
    setPending(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success("Rebuilt — picked up the latest services + policies.")
    router.refresh()
  }

  async function handleDelete() {
    const ok = await confirm({
      title: "Delete the voice receptionist?",
      description:
        "We'll wipe the assistant from Vapi. Pick a voice + tone again any time to rebuild.",
      confirmLabel: "Delete it",
      tone: "destructive",
    })
    if (!ok) return
    setPending("delete")
    const result = await deleteVapiAssistant()
    setPending(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setSavedId("")
    toast.success("Deleted.")
    router.refresh()
  }

  async function handleSavePaste(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const value = pasteId.trim() || null
    setPending("save_paste")
    const result = await saveVapiAssistantId({ vapi_assistant_id: value })
    setPending(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setSavedId(result.shop.vapi_assistant_id ?? "")
    toast.success(value ? "Linked to that assistant." : "Disconnected.")
    router.refresh()
  }

  return (
    <Card id="voice" className="scroll-mt-20 border-border/80">
      {confirmDialog}
      <CardHeader className="flex flex-row items-center gap-3 space-y-0">
        <div className="flex size-10 items-center justify-center rounded-lg bg-muted/60">
          <Mic className="size-5 text-primary" aria-hidden />
        </div>
        <div className="flex-1">
          <CardTitle className="text-base font-medium">
            Voice receptionist
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            We build the assistant from your services + shop knowledge.
            One voice, one click, ready to take calls.
          </p>
        </div>
        {isConnected ? (
          <StatusPill
            tone="good"
            size="default"
            icon={<Check className="size-3" aria-hidden />}
          >
            Connected
          </StatusPill>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-5">
        <AnimatePresence mode="wait" initial={false}>
          {mode === "building" ? (
            <motion.div
              key="building"
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }}
              transition={{ duration: 0.3, ease: EASE_OUT_EXPO }}
              className="space-y-5"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <p className="label-eyebrow text-muted-foreground/70">
                    Build the receptionist
                  </p>
                  <p className="text-sm text-foreground">
                    Pick a voice and tone. We&apos;ll wire it to your service
                    menu + policies automatically.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setMode("summary")}
                  aria-label="Cancel"
                  className="text-muted-foreground transition-colors hover:text-foreground"
                >
                  <X className="size-4" aria-hidden />
                </button>
              </div>

              <div className="grid gap-2">
                <p className="label-eyebrow text-muted-foreground/70">Voice</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {VOICE_OPTIONS.map((v) => {
                    const active = voice === v.id
                    return (
                      <button
                        key={v.id}
                        type="button"
                        onClick={() => setVoice(v.id)}
                        className={cn(
                          "rounded-xl border px-3.5 py-3 text-left transition-colors",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                          active
                            ? "border-primary/50 bg-primary/8"
                            : "border-border/50 bg-muted/15 hover:border-border hover:bg-muted/25"
                        )}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <span className="text-sm font-medium text-foreground">
                            {v.label}
                          </span>
                          {active ? (
                            <Check
                              className="mt-0.5 size-3.5 text-primary"
                              aria-hidden
                            />
                          ) : null}
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {v.description}
                        </p>
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className="grid gap-2">
                <p className="label-eyebrow text-muted-foreground/70">Tone</p>
                <div className="grid gap-2 sm:grid-cols-3">
                  {TONE_OPTIONS.map((t) => {
                    const active = tone === t.id
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => setTone(t.id)}
                        className={cn(
                          "rounded-xl border px-3 py-2.5 text-left transition-colors",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                          active
                            ? "border-primary/50 bg-primary/8"
                            : "border-border/50 bg-muted/15 hover:border-border hover:bg-muted/25"
                        )}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium text-foreground">
                            {t.label}
                          </span>
                          {active ? (
                            <Check
                              className="size-3.5 text-primary"
                              aria-hidden
                            />
                          ) : null}
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {t.description}
                        </p>
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className="grid gap-2">
                <Label
                  htmlFor="vapi-greeting"
                  className="label-eyebrow text-muted-foreground/70"
                >
                  Greeting (optional)
                </Label>
                <Textarea
                  id="vapi-greeting"
                  value={greeting}
                  onChange={(e) => setGreeting(e.target.value.slice(0, 200))}
                  placeholder={defaultGreeting}
                  rows={2}
                  className="resize-none border-border/60 bg-background/60 focus-visible:border-primary/40"
                />
                <p className="text-xs text-muted-foreground">
                  Leave blank and we&apos;ll use:{" "}
                  <span className="italic">{defaultGreeting}</span>
                </p>
              </div>

              <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setMode("summary")}
                  disabled={pending !== null}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={isConnected ? handleRebuild : handleBuild}
                  disabled={pending !== null}
                  size="lg"
                  className="h-11 gap-2 transition-transform duration-200 active:scale-[0.98]"
                >
                  {pending === "build" || pending === "rebuild" ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  ) : (
                    <Sparkles className="size-4" aria-hidden />
                  )}
                  {isConnected ? "Rebuild" : "Build the receptionist"}
                </Button>
              </div>
            </motion.div>
          ) : isConnected ? (
            <motion.div
              key="connected"
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }}
              transition={{ duration: 0.3, ease: EASE_OUT_EXPO }}
              className="space-y-4"
            >
              <div className="flex items-center gap-3 rounded-xl border border-border/50 bg-muted/15 px-3.5 py-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary ring-1 ring-primary/25">
                  <Mic className="size-4" aria-hidden />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="label-eyebrow text-muted-foreground/70">
                    Live assistant
                  </p>
                  <p className="truncate text-sm font-medium text-foreground">
                    {shopName?.trim() || "Your shop"} — voice receptionist
                  </p>
                  <p className="truncate text-xs tabular-nums text-muted-foreground">
                    {savedId}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={handleDelete}
                  disabled={pending !== null}
                  className="gap-2 text-muted-foreground hover:text-destructive"
                >
                  {pending === "delete" ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  ) : (
                    <Trash2 className="size-4" aria-hidden />
                  )}
                  Delete
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setMode("building")}
                  disabled={pending !== null || !vapiConfigured}
                  className="gap-2"
                >
                  <RefreshCw className="size-4" aria-hidden />
                  Rebuild with current shop
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Rebuild re-syncs the prompt with your latest services +
                shop knowledge. Use after you add a new service or paste
                new policy text.
              </p>
            </motion.div>
          ) : (
            <motion.div
              key="disconnected"
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }}
              transition={{ duration: 0.3, ease: EASE_OUT_EXPO }}
              className="space-y-4"
            >
              <p className="text-sm text-muted-foreground">
                We assemble the assistant from your shop name, service
                menu, and any policy text you&apos;ve pasted into shop
                knowledge. No prompt engineering on your end.
              </p>
              <div className="flex flex-wrap items-center justify-end gap-2">
                {vapiConfigured ? (
                  <Button
                    type="button"
                    onClick={() => setMode("building")}
                    size="lg"
                    className="h-11 gap-2 transition-transform duration-200 active:scale-[0.98]"
                  >
                    <Sparkles className="size-4" aria-hidden />
                    Build the receptionist
                  </Button>
                ) : (
                  <Button type="button" disabled>
                    Vapi not configured
                  </Button>
                )}
              </div>
              {!vapiConfigured ? (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  Server needs <code>VAPI_API_KEY</code> set.
                </p>
              ) : null}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Advanced: paste an existing Vapi assistant id manually */}
        <details
          className="rounded-xl border border-border/40 bg-card/30 px-3.5"
          open={showAdvanced}
          onToggle={(e) =>
            setShowAdvanced((e.target as HTMLDetailsElement).open)
          }
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 py-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
            <span>
              Advanced: link an assistant you built yourself in the Vapi
              dashboard
            </span>
            <ChevronDown
              className={cn(
                "size-3.5 transition-transform duration-200",
                showAdvanced && "rotate-180"
              )}
              aria-hidden
            />
          </summary>
          <div className="space-y-4 pb-3 pt-2">
            <ol className="grid gap-2 text-xs text-muted-foreground">
              <li>
                <span className="font-medium text-foreground">1.</span> Open
                your assistant in the Vapi dashboard.
              </li>
              <li>
                <span className="font-medium text-foreground">2.</span> Set
                Server URL to{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-foreground">
                  {webhookUrl}
                </code>
                {webhookSecretConfigured ? null : (
                  <span className="text-amber-600 dark:text-amber-400">
                    {" "}
                    (and set <code>VAPI_WEBHOOK_SECRET</code> on the server
                    — it isn&apos;t set yet)
                  </span>
                )}
                .
              </li>
              <li>
                <span className="font-medium text-foreground">3.</span> Copy
                the assistant&apos;s ID and paste it below.
              </li>
            </ol>
            <form className="grid gap-3" onSubmit={handleSavePaste}>
              <div className="grid gap-2">
                <Label htmlFor="vapi-assistant-id">Vapi assistant ID</Label>
                <Input
                  id="vapi-assistant-id"
                  name="vapi_assistant_id"
                  placeholder="e.g. a1b2c3d4-…"
                  value={pasteId}
                  onChange={(e) => setPasteId(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div className="flex justify-end">
                <Button
                  type="submit"
                  disabled={pending !== null}
                  variant="outline"
                >
                  {pending === "save_paste" ? (
                    <>
                      <Loader2 className="size-4 animate-spin" aria-hidden />
                      Saving
                    </>
                  ) : (
                    "Link assistant"
                  )}
                </Button>
              </div>
            </form>
          </div>
        </details>
      </CardContent>
    </Card>
  )
}

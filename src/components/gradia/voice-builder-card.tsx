"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import {
  BadgeCheck,
  Eye,
  Loader2,
  Phone,
  PhoneCall,
  Rocket,
} from "lucide-react"
import { toast } from "sonner"

import {
  connectVoiceNumber,
  getVoicePreview,
  requestVoiceTestCall,
  saveVoiceConfig,
  saveVoiceMinutesBudget,
  setVoiceLive,
  type VoiceConfigInput,
} from "@/app/actions/voice-builder"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { ShopRow, VoiceConfig } from "@/lib/types/database"
import { cn } from "@/lib/utils"

type VoiceOption = { id: string; label: string; description: string }

type BuilderShop = Pick<
  ShopRow,
  | "phone"
  | "voice_config"
  | "voice_live"
  | "voice_test_called_at"
  | "voice_minutes_budget"
  | "vapi_assistant_id"
  | "vapi_phone_number_id"
  | "gradia_number_e164"
>

function formFrom(config: VoiceConfig | null, fallbackVoice: string): VoiceConfigInput {
  return {
    greeting: config?.greeting ?? "",
    tone: config?.tone ?? "warm",
    voice: config?.voice ?? fallbackVoice,
    after_hours: config?.after_hours ?? "take_message",
    hours_text: config?.hours_text ?? "",
    booking_mode: config?.booking_mode ?? "propose_booking",
    calendar_link: config?.calendar_link ?? "",
    escalation_phone: config?.escalation_phone ?? "",
  }
}

/**
 * The Phase 2 voice receptionist builder (spec §2.1–2.5). A guardrailed
 * form — owners configure facts; the prompt is composed server-side and
 * shown read-only. Launch is gated on number + saved receptionist + a
 * completed test call.
 */
export function VoiceBuilderCard({
  shop,
  voiceOptions,
  vapiConfigured,
}: {
  shop: BuilderShop
  voiceOptions: VoiceOption[]
  vapiConfigured: boolean
}) {
  const router = useRouter()
  const [form, setForm] = React.useState<VoiceConfigInput>(
    formFrom(shop.voice_config, voiceOptions[0]?.id ?? "warm-female")
  )
  const [pending, setPending] = React.useState<
    null | "save" | "preview" | "connect" | "test" | "launch" | "budget"
  >(null)
  const [preview, setPreview] = React.useState<string | null>(null)
  const [testNumber, setTestNumber] = React.useState(shop.phone ?? "")
  const [budget, setBudget] = React.useState(
    shop.voice_minutes_budget != null ? String(shop.voice_minutes_budget) : ""
  )

  const set = (patch: Partial<VoiceConfigInput>) =>
    setForm((f) => ({ ...f, ...patch }))

  const hasAssistant = Boolean(shop.vapi_assistant_id)
  const hasNumber = Boolean(shop.vapi_phone_number_id)
  const hasTested = Boolean(shop.voice_test_called_at)
  const canLaunch = hasAssistant && hasNumber && hasTested

  async function run<T extends { ok: true } | { ok: false; error: string }>(
    kind: NonNullable<typeof pending>,
    fn: () => Promise<T>,
    successMessage: string
  ): Promise<T | null> {
    if (pending) return null
    setPending(kind)
    const result = await fn()
    setPending(null)
    if (!result.ok) {
      toast.error(result.error)
      return result
    }
    toast.success(successMessage)
    router.refresh()
    return result
  }

  async function handlePreview() {
    if (pending) return
    setPending("preview")
    const p = await getVoicePreview(form)
    setPending(null)
    setPreview(p.systemPrompt ? `${p.firstMessage}\n\n---\n\n${p.systemPrompt}` : null)
  }

  return (
    <Card className="border-border/70">
      <CardHeader className="space-y-1">
        <p className="label-eyebrow text-muted-foreground/70">Voice receptionist</p>
        <CardTitle className="font-display text-xl tracking-tight">
          Who answers when we&apos;re <em className="italic">under the hood</em>
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Tell us the facts — greeting, hours, how booking works. We compose
          the receptionist from your services, policies, and our shared voice.
          Bookings and payments always wait for your approval.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* ---- The form (guardrailed — facts only) ---- */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="vb-greeting">Greeting line</Label>
            <Input
              id="vb-greeting"
              value={form.greeting ?? ""}
              onChange={(e) => set({ greeting: e.target.value })}
              placeholder="Thanks for calling — what can we do for you?"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="vb-voice">Voice</Label>
            <Select
              value={form.voice ?? undefined}
              onValueChange={(v) => {
                if (v) set({ voice: v })
              }}
            >
              <SelectTrigger id="vb-voice">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {voiceOptions.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    {v.label} — {v.description}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="vb-tone">Tone</Label>
            <Select
              value={form.tone ?? "warm"}
              onValueChange={(v) => set({ tone: v as VoiceConfigInput["tone"] })}
            >
              <SelectTrigger id="vb-tone">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="warm">Warm — a trusted teammate</SelectItem>
                <SelectItem value="professional">Professional — senior advisor</SelectItem>
                <SelectItem value="playful">Playful — friendly, still sharp</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="vb-hours">Business hours (plain words)</Label>
            <Input
              id="vb-hours"
              value={form.hours_text ?? ""}
              onChange={(e) => set({ hours_text: e.target.value })}
              placeholder="Mon–Sat 8am–6pm"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="vb-after">After hours, we should…</Label>
            <Select
              value={form.after_hours ?? "take_message"}
              onValueChange={(v) =>
                set({ after_hours: v as VoiceConfigInput["after_hours"] })
              }
            >
              <SelectTrigger id="vb-after">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="take_message">Take a message for the morning</SelectItem>
                <SelectItem value="message_only">Just say when we reopen</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="vb-booking">Bookings</Label>
            <Select
              value={form.booking_mode ?? "propose_booking"}
              onValueChange={(v) =>
                set({ booking_mode: v as VoiceConfigInput["booking_mode"] })
              }
            >
              <SelectTrigger id="vb-booking">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="propose_booking">
                  Collect the request — we approve before anything books
                </SelectItem>
                <SelectItem value="calendar_link">Text callers our booking link</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {form.booking_mode === "calendar_link" ? (
            <div className="space-y-1.5">
              <Label htmlFor="vb-cal">Booking link</Label>
              <Input
                id="vb-cal"
                value={form.calendar_link ?? ""}
                onChange={(e) => set({ calendar_link: e.target.value })}
                placeholder="https://cal.com/your-shop"
              />
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="vb-escalation">Transfer-to-you number (optional)</Label>
            <Input
              id="vb-escalation"
              value={form.escalation_phone ?? ""}
              onChange={(e) => set({ escalation_phone: e.target.value })}
              placeholder="+16175550142"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            onClick={() =>
              run("save", () => saveVoiceConfig(form), hasAssistant
                ? "Receptionist updated."
                : "Receptionist created — connect your number next.")
            }
            disabled={pending !== null || !vapiConfigured}
            className="gap-2"
          >
            {pending === "save" ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : null}
            {hasAssistant ? "Save changes" : "Create receptionist"}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={handlePreview}
            disabled={pending !== null}
            className="gap-2"
          >
            {pending === "preview" ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Eye className="size-4" aria-hidden />
            )}
            What your receptionist knows
          </Button>
          {!vapiConfigured ? (
            <p className="text-xs text-muted-foreground">
              Voice isn&apos;t configured on the server yet.
            </p>
          ) : null}
        </div>

        {preview ? (
          <div className="space-y-1.5">
            <p className="label-eyebrow text-muted-foreground/70">
              Composed from your services, policies, and our shared voice — read-only
            </p>
            <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-xl border border-border/50 bg-muted/15 p-3.5 text-xs leading-relaxed text-muted-foreground">
              {preview}
            </pre>
          </div>
        ) : null}

        {/* ---- Launch checklist ---- */}
        <div className="space-y-3 rounded-xl border border-border/50 bg-muted/15 p-3.5">
          <p className="label-eyebrow text-muted-foreground/70">Going live</p>
          <ol className="space-y-2 text-sm">
            <li className={cn("flex items-center gap-2", hasAssistant && "text-muted-foreground")}>
              <BadgeCheck
                className={cn("size-4", hasAssistant ? "text-emerald-500" : "text-muted-foreground/40")}
                aria-hidden
              />
              Receptionist saved
            </li>
            <li className={cn("flex items-center gap-2", hasNumber && "text-muted-foreground")}>
              <Phone
                className={cn("size-4", hasNumber ? "text-emerald-500" : "text-muted-foreground/40")}
                aria-hidden
              />
              {hasNumber ? (
                "Business number connected"
              ) : shop.gradia_number_e164 ? (
                <span className="flex flex-wrap items-center gap-2">
                  Connect {shop.gradia_number_e164} to voice
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={pending !== null || !hasAssistant}
                    onClick={() =>
                      run("connect", connectVoiceNumber, "Calls now reach your receptionist — texts still come to us.")
                    }
                    className="gap-1.5"
                  >
                    {pending === "connect" ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden />
                    ) : null}
                    Connect
                  </Button>
                </span>
              ) : (
                "Buy a business number first (SMS settings above)"
              )}
            </li>
            <li className={cn("flex items-center gap-2", hasTested && "text-muted-foreground")}>
              <PhoneCall
                className={cn("size-4", hasTested ? "text-emerald-500" : "text-muted-foreground/40")}
                aria-hidden
              />
              {hasTested ? (
                "Test call done"
              ) : (
                <span className="flex flex-wrap items-center gap-2">
                  We call you, you meet the receptionist:
                  <Input
                    value={testNumber}
                    onChange={(e) => setTestNumber(e.target.value)}
                    placeholder="+16175550142"
                    className="h-8 w-44"
                    aria-label="Your phone number for the test call"
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={pending !== null || !hasNumber}
                    onClick={() =>
                      run("test", () => requestVoiceTestCall({ toNumber: testNumber.trim() }), "Ringing you now — pick up and say hi.")
                    }
                    className="gap-1.5"
                  >
                    {pending === "test" ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden />
                    ) : null}
                    Call me
                  </Button>
                </span>
              )}
            </li>
          </ol>
          <div className="flex items-center justify-between gap-3 border-t border-border/40 pt-3">
            <p className="text-sm text-foreground">
              {shop.voice_live
                ? "Live — we're answering your calls."
                : canLaunch
                  ? "Everything's ready when you are."
                  : "Finish the checklist to go live."}
            </p>
            <Button
              type="button"
              variant={shop.voice_live ? "outline" : "default"}
              disabled={pending !== null || (!shop.voice_live && !canLaunch)}
              onClick={() =>
                run(
                  "launch",
                  () => setVoiceLive(!shop.voice_live),
                  shop.voice_live ? "Paused — calls ring through untouched." : "We're live. Go do the in-person work."
                )
              }
              className="gap-2"
            >
              {pending === "launch" ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Rocket className="size-4" aria-hidden />
              )}
              {shop.voice_live ? "Pause" : "Go live"}
            </Button>
          </div>
        </div>

        {/* ---- Minute budget (spec §2.5) ---- */}
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="vb-budget">Monthly minute budget (optional)</Label>
            <Input
              id="vb-budget"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              placeholder="e.g. 200"
              className="w-40"
              inputMode="numeric"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending !== null}
            onClick={() => {
              const trimmed = budget.trim()
              const minutes = trimmed === "" ? null : Number.parseInt(trimmed, 10)
              if (minutes !== null && !Number.isFinite(minutes)) {
                toast.error("Enter a whole number of minutes (or clear for no cap).")
                return
              }
              void run("budget", () => saveVoiceMinutesBudget(minutes), "Budget saved.")
            }}
          >
            {pending === "budget" ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : null}
            Save budget
          </Button>
          <p className="basis-full text-xs text-muted-foreground">
            We warn you at 80%. At 100% the receptionist switches to
            take-a-message until the month resets — never a surprise bill.
          </p>
        </div>
      </CardContent>
    </Card>
  )
}

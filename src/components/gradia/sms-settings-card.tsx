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
  MessageSquare,
  Phone,
  Plug,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"

import {
  clearTwilioCredentials,
  disconnectSms,
  saveTwilioCredentials,
  saveTwilioNumber,
} from "@/app/actions/shop"
import { releaseTwilioNumber } from "@/app/actions/twilio-provision"
import { TwilioNumberPicker } from "@/components/gradia/twilio-number-picker"
import { EASE_OUT_EXPO } from "@/components/gradia/motion/page-stagger"
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
import { cn } from "@/lib/utils"

function formatPhone(e164: string): string {
  const digits = e164.replace(/\D/g, "")
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`
  }
  return e164
}

export function SmsSettingsCard({
  initialPhoneNumber,
  webhookUrl,
  twilioConfigured,
  byoConnected: initialByoConnected,
}: {
  initialPhoneNumber: string | null
  webhookUrl: string
  twilioConfigured: boolean
  byoConnected: boolean
}) {
  const router = useRouter()
  const reduce = useReducedMotion()
  const { confirm, dialog: confirmDialog } = useConfirm()
  const [savedValue, setSavedValue] = React.useState(initialPhoneNumber ?? "")
  const [picking, setPicking] = React.useState(false)
  const [showAdvanced, setShowAdvanced] = React.useState(false)
  const [pastePhone, setPastePhone] = React.useState("")
  const [pending, setPending] = React.useState<
    null | "save_paste" | "disconnect" | "release" | "save_byo" | "clear_byo"
  >(null)
  const [byoConnected, setByoConnected] = React.useState(initialByoConnected)
  const [accountSid, setAccountSid] = React.useState("")
  const [authToken, setAuthToken] = React.useState("")

  const isConnected = savedValue.trim().length > 0

  // No useEffect-sync on initialPhoneNumber: every action handler
  // updates savedValue optimistically and then calls router.refresh.
  // The subsequent re-render with the new prop value lands on a
  // remounted card (parent server component re-runs), so local state
  // and prop stay in sync without a setState-in-effect.

  async function handleSavePaste(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const value = pastePhone.trim() || null
    setPending("save_paste")
    const result = await saveTwilioNumber({ twilio_phone_number: value })
    setPending(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    const next = result.shop.twilio_phone_number ?? ""
    setSavedValue(next)
    setPastePhone(next)
    toast.success(value ? "SMS connected." : "Disconnected.")
  }

  async function handleSaveCredentials(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setPending("save_byo")
    const result = await saveTwilioCredentials({
      twilio_account_sid: accountSid.trim(),
      twilio_auth_token: authToken.trim(),
    })
    setPending(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setByoConnected(true)
    setAccountSid("")
    setAuthToken("")
    toast.success(
      "Texting credentials saved — your own account now sends for this shop."
    )
  }

  async function handleClearCredentials() {
    const ok = await confirm({
      title: "Clear your texting credentials?",
      description:
        "Outbound SMS falls back to Gradia's pilot account until you paste them again.",
      confirmLabel: "Clear",
      tone: "destructive",
    })
    if (!ok) return
    setPending("clear_byo")
    const result = await clearTwilioCredentials()
    setPending(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setByoConnected(false)
    toast.success("Cleared — falling back to Gradia's pilot account.")
  }

  async function handleDisconnect() {
    setPending("disconnect")
    const result = await disconnectSms()
    setPending(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setSavedValue("")
    setPastePhone("")
    toast.success("SMS disconnected — the number stays reserved for you.")
    router.refresh()
  }

  async function handleRelease() {
    const ok = await confirm({
      title: "Release this number?",
      description:
        "We release the number and stop the monthly rental. You can pick a new one anytime.",
      confirmLabel: "Release & disconnect",
      tone: "destructive",
    })
    if (!ok) return
    setPending("release")
    const result = await releaseTwilioNumber()
    setPending(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setSavedValue("")
    setPastePhone("")
    toast.success("Released — rental stopped.")
    router.refresh()
  }

  return (
    <Card id="sms" className="scroll-mt-20 border-border/80">
      {confirmDialog}
      <CardHeader className="flex flex-row items-center gap-3 space-y-0">
        <div className="flex size-10 items-center justify-center rounded-lg bg-muted/60">
          <MessageSquare className="size-5 text-primary" aria-hidden />
        </div>
        <div className="flex-1">
          <CardTitle className="text-base font-medium">
            SMS receptionist
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Pick an area code, get a number, every text becomes an
            approval card.
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
          {picking ? (
            <motion.div
              key="picker"
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }}
              transition={{ duration: 0.3, ease: EASE_OUT_EXPO }}
            >
              <TwilioNumberPicker onCancel={() => setPicking(false)} />
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
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/12 text-emerald-500 ring-1 ring-emerald-500/25 dark:text-emerald-400">
                  <Phone className="size-4" aria-hidden />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="label-eyebrow text-muted-foreground/70">
                    Your shop number
                  </p>
                  <p className="truncate text-base font-medium text-foreground tabular-nums">
                    {formatPhone(savedValue)}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={handleDisconnect}
                  disabled={pending !== null}
                  className="text-muted-foreground hover:text-foreground"
                >
                  {pending === "disconnect" ? (
                    <>
                      <Loader2 className="size-4 animate-spin" aria-hidden />
                      Disconnecting
                    </>
                  ) : (
                    "Disconnect"
                  )}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={handleRelease}
                  disabled={pending !== null}
                  className="gap-2 text-muted-foreground hover:text-destructive"
                >
                  {pending === "release" ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  ) : (
                    <Trash2 className="size-4" aria-hidden />
                  )}
                  Release & stop billing
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setPicking(true)}
                  disabled={pending !== null || !twilioConfigured}
                  className="gap-2"
                >
                  <Phone className="size-4" aria-hidden />
                  Pick a different number
                </Button>
              </div>
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
                Pick a local business number and Gradia wires everything
                up automatically. You&apos;ll see the monthly price before
                you buy — billed through your Gradia plan.
              </p>
              <div className="flex flex-wrap items-center justify-end gap-2">
                {twilioConfigured ? (
                  <Button
                    type="button"
                    onClick={() => setPicking(true)}
                    className="gap-2"
                  >
                    <Phone className="size-4" aria-hidden />
                    Pick a Gradia number
                  </Button>
                ) : (
                  <Button type="button" disabled>
                    Numbers coming soon
                  </Button>
                )}
              </div>
              {!twilioConfigured ? (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  We're finishing texting setup on our side — check back soon.
                </p>
              ) : null}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Advanced: BYO Twilio account + manual number paste */}
        <details
          className="rounded-xl border border-border/40 bg-card/30 px-3.5"
          open={showAdvanced}
          onToggle={(e) =>
            setShowAdvanced((e.target as HTMLDetailsElement).open)
          }
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 py-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
            <span>
              Advanced: bring your own texting account or paste a number
            </span>
            <ChevronDown
              className={cn(
                "size-3.5 transition-transform duration-200",
                showAdvanced && "rotate-180"
              )}
              aria-hidden
            />
          </summary>

          <div className="space-y-5 pb-4 pt-2">
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-foreground">
                    Your own texting account
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Past the pilot, paste your own credentials. Your
                    deliverability, your carrier verification, your bill.
                    Encrypted at rest.
                  </p>
                </div>
                {byoConnected ? (
                  <StatusPill
                    tone="good"
                    icon={<Check className="size-3" aria-hidden />}
                  >
                    BYO
                  </StatusPill>
                ) : null}
              </div>
              <form className="grid gap-3" onSubmit={handleSaveCredentials}>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="grid gap-2">
                    <Label htmlFor="twilio-sid">Account SID</Label>
                    <Input
                      id="twilio-sid"
                      value={accountSid}
                      onChange={(e) => setAccountSid(e.target.value)}
                      placeholder="AC…"
                      autoComplete="off"
                      spellCheck={false}
                      disabled={pending !== null}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="twilio-token">
                      Auth Token {byoConnected ? "(re-paste to update)" : ""}
                    </Label>
                    <Input
                      id="twilio-token"
                      value={authToken}
                      onChange={(e) => setAuthToken(e.target.value)}
                      placeholder="••••••••"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      disabled={pending !== null}
                    />
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {byoConnected ? (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleClearCredentials}
                      disabled={pending !== null}
                    >
                      {pending === "clear_byo" ? (
                        <Loader2
                          className="size-4 animate-spin"
                          aria-hidden
                        />
                      ) : null}
                      Clear
                    </Button>
                  ) : null}
                  <Button
                    type="submit"
                    disabled={
                      pending !== null ||
                      !accountSid.trim() ||
                      !authToken.trim()
                    }
                    className="min-w-32"
                  >
                    {pending === "save_byo" ? (
                      <>
                        <Loader2
                          className="size-4 animate-spin"
                          aria-hidden
                        />
                        Saving
                      </>
                    ) : byoConnected ? (
                      "Update credentials"
                    ) : (
                      "Save credentials"
                    )}
                  </Button>
                </div>
              </form>
            </div>

            <div className="space-y-3 border-t border-border/30 pt-4">
              <div>
                <p className="text-sm font-medium text-foreground">
                  Paste a number you already own
                </p>
                <p className="text-xs text-muted-foreground">
                  Point its webhook at{" "}
                  <code className="rounded bg-muted px-1 py-0.5 text-xs text-foreground">
                    {webhookUrl}
                  </code>{" "}
                  with method <strong>HTTP POST</strong>, then paste the
                  E.164 number below.
                </p>
              </div>
              <form className="grid gap-3" onSubmit={handleSavePaste}>
                <div className="grid gap-2">
                  <Label htmlFor="twilio-number-paste">Phone number</Label>
                  <Input
                    id="twilio-number-paste"
                    name="twilio_phone_number"
                    placeholder="+15551234567"
                    value={pastePhone}
                    onChange={(e) => setPastePhone(e.target.value)}
                    autoComplete="off"
                    inputMode="tel"
                    spellCheck={false}
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    type="submit"
                    disabled={pending !== null}
                    variant="outline"
                  >
                    {pending === "save_paste" ? (
                      <>
                        <Loader2
                          className="size-4 animate-spin"
                          aria-hidden
                        />
                        Saving
                      </>
                    ) : (
                      <>
                        <Plug className="size-4" aria-hidden />
                        Save number
                      </>
                    )}
                  </Button>
                </div>
              </form>
            </div>
          </div>
        </details>
      </CardContent>
    </Card>
  )
}

"use client"

import * as React from "react"
import { AnimatePresence, motion, useReducedMotion } from "framer-motion"
import { Loader2, Sparkles, Wand2 } from "lucide-react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { processRawLeadNote } from "@/app/actions/ai-lead"
import { createLead, type CreateLeadResult } from "@/app/actions/leads"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { MotionCard } from "@/components/gradia/motion/motion-card"
import {
  PageStagger,
  StaggerItem,
} from "@/components/gradia/motion/page-stagger"
import { SectionHeader } from "@/components/gradia/section-header"

/**
 * Claude runs only when the user clicks "Pull out the details"
 * (`handleProcess`). Do not add useEffect/onChange handlers that
 * call `processRawLeadNote`.
 */
export function AiLeadSection() {
  const router = useRouter()
  const reduce = useReducedMotion()
  const [raw, setRaw] = React.useState("")
  const [processing, setProcessing] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [extracted, setExtracted] = React.useState(false)

  const [customerName, setCustomerName] = React.useState("")
  const [phone, setPhone] = React.useState("")
  const [carInfo, setCarInfo] = React.useState("")
  const [service, setService] = React.useState("")

  async function handleProcess() {
    setProcessing(true)
    const result = await processRawLeadNote(raw)
    setProcessing(false)

    if (!result.ok) {
      toast.error(result.error)
      return
    }

    setCustomerName(result.data.name)
    setPhone(result.data.phone)
    setCarInfo(result.data.carInfo)
    setService(result.data.service)
    setExtracted(true)
    toast.success("Here's what we caught — tweak anything before saving.")
  }

  async function handleSaveLead(e: React.FormEvent) {
    e.preventDefault()
    if (!customerName.trim()) {
      toast.error("Give the lead a name before we save it.")
      return
    }
    if (phone.trim().length < 5) {
      toast.error("Add a real phone number so we can reach them.")
      return
    }

    setSaving(true)
    const payload = {
      customerName: customerName.trim(),
      phone: phone.trim(),
      carInfo: carInfo.trim() || null,
      pinNotes: service.trim() || null,
      status: "new" as const,
    }
    const res: CreateLeadResult = await createLead(payload)
    setSaving(false)

    if (res.ok) {
      toast.success("Queued — approve it in Approvals to lock it in.")
      setRaw("")
      setCustomerName("")
      setPhone("")
      setCarInfo("")
      setService("")
      setExtracted(false)
      router.refresh()
      return
    }

    toast.error(res.error)
  }

  const canSave =
    extracted && customerName.trim().length > 0 && phone.trim().length >= 5

  return (
    <section className="space-y-5">
      <SectionHeader
        eyebrow="AI · Lead capture"
        title={
          <>
            A messy note, a <span className="italic">clean</span>{" "}lead.
          </>
        }
        subhead="Paste anything — a text thread, a walk-in scribble, a voicemail transcript. We'll pull the name, phone, vehicle, and what they want."
      />

      <MotionCard interactive={false} className="overflow-hidden">
        <div className="flex items-start gap-3 border-b border-border/50 px-6 pb-5 pt-6 sm:px-8">
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary ring-1 ring-primary/25"
          >
            <Sparkles className="size-[18px]" aria-hidden />
          </motion.div>
          <div className="min-w-0 space-y-1">
            <p className="label-eyebrow text-muted-foreground/70">
              Drop the note
            </p>
            <p className="text-sm text-muted-foreground">
              We&apos;ll structure it when you tap{" "}
              <span className="font-medium text-foreground">
                Pull out the details
              </span>
              .
            </p>
          </div>
        </div>

        <div className="grid gap-6 px-6 pb-6 pt-6 sm:px-8">
          <div className="grid gap-2">
            <Label
              htmlFor="ai-raw-note"
              className="label-eyebrow text-muted-foreground/70"
            >
              Raw note
            </Label>
            <Textarea
              id="ai-raw-note"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              autoComplete="off"
              spellCheck
              placeholder={`e.g. "hey it's mike — 555 102 9922, white 2019 f150, wants a full detail in & out before saturday"`}
              rows={8}
              className="min-h-[180px] resize-y font-mono text-sm leading-relaxed"
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              onClick={handleProcess}
              disabled={processing || !raw.trim()}
              size="lg"
              className="h-11 gap-2 px-5 transition-transform duration-200 active:scale-[0.98]"
            >
              {processing ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  Reading it…
                </>
              ) : (
                <>
                  <Wand2 className="size-4" aria-hidden />
                  Pull out the details
                </>
              )}
            </Button>
            {!extracted && raw.trim().length > 0 ? (
              <p className="text-xs text-muted-foreground">
                We&apos;ll figure out who, what, and when.
              </p>
            ) : null}
          </div>

          <AnimatePresence initial={false} mode="wait">
            {extracted ? (
              <motion.form
                key="extracted"
                onSubmit={handleSaveLead}
                initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8 }}
                transition={{ duration: 0.15, ease: "easeOut" }}
                className="relative overflow-hidden rounded-xl border border-border/60 bg-muted/20 p-5"
              >
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent"
                />
                <div className="mb-5 flex items-center justify-between gap-3">
                  <div className="space-y-0.5">
                    <p className="label-eyebrow text-muted-foreground/70">
                      What we caught
                    </p>
                    <p className="text-sm text-foreground">
                      Tweak anything before saving.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setExtracted(false)
                      setCustomerName("")
                      setPhone("")
                      setCarInfo("")
                      setService("")
                    }}
                    className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Start over
                  </button>
                </div>

                <PageStagger className="grid gap-4">
                  <StaggerItem>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="grid gap-1.5">
                        <Label
                          htmlFor="ai-customer"
                          className="label-eyebrow text-muted-foreground/70"
                        >
                          Customer
                        </Label>
                        <Input
                          id="ai-customer"
                          value={customerName}
                          onChange={(e) => setCustomerName(e.target.value)}
                          autoComplete="name"
                          placeholder="Mike Torres"
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <Label
                          htmlFor="ai-phone"
                          className="label-eyebrow text-muted-foreground/70"
                        >
                          Phone
                        </Label>
                        <Input
                          id="ai-phone"
                          value={phone}
                          onChange={(e) => setPhone(e.target.value)}
                          type="tel"
                          autoComplete="tel"
                          placeholder="(555) 102-9922"
                          className="tabular-nums"
                        />
                      </div>
                    </div>
                  </StaggerItem>

                  <StaggerItem>
                    <div className="grid gap-1.5">
                      <Label
                        htmlFor="ai-car"
                        className="label-eyebrow text-muted-foreground/70"
                      >
                        Vehicle
                      </Label>
                      <Input
                        id="ai-car"
                        value={carInfo}
                        onChange={(e) => setCarInfo(e.target.value)}
                        placeholder="2019 Ford F-150 — white"
                      />
                    </div>
                  </StaggerItem>

                  <StaggerItem>
                    <div className="grid gap-1.5">
                      <Label
                        htmlFor="ai-service"
                        className="label-eyebrow text-muted-foreground/70"
                      >
                        What they want
                      </Label>
                      <Textarea
                        id="ai-service"
                        value={service}
                        onChange={(e) => setService(e.target.value)}
                        placeholder="Full exterior + interior before Saturday"
                        rows={3}
                        className="resize-y"
                      />
                      <p className="text-xs text-muted-foreground">
                        Saved on the lead so the next touch already knows the ask.
                      </p>
                    </div>
                  </StaggerItem>

                  <StaggerItem>
                    <div className="flex flex-wrap items-center gap-3 pt-1">
                      <Button
                        type="submit"
                        disabled={saving || !canSave}
                        size="lg"
                        className="h-11 gap-2 px-5 transition-transform duration-200 active:scale-[0.98]"
                      >
                        {saving ? (
                          <>
                            <Loader2
                              className="size-4 animate-spin"
                              aria-hidden
                            />
                            Saving the lead…
                          </>
                        ) : (
                          "Save the lead"
                        )}
                      </Button>
                      <p className="text-xs text-muted-foreground">
                        Lands in Approvals — confirm once and it&apos;s live.
                      </p>
                    </div>
                  </StaggerItem>
                </PageStagger>
              </motion.form>
            ) : null}
          </AnimatePresence>
        </div>
      </MotionCard>
    </section>
  )
}

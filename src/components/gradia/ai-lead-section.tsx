"use client"

import * as React from "react"
import { Loader2, Sparkles, Wand2 } from "lucide-react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { processRawLeadNote } from "@/app/actions/ai-lead"
import { createLead, type CreateLeadResult } from "@/app/actions/leads"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"

/**
 * Claude runs only when the user clicks "Process" (`handleProcess`).
 * Do not add useEffect/onChange handlers that call `processRawLeadNote`.
 */
export function AiLeadSection() {
  const router = useRouter()
  const [raw, setRaw] = React.useState("")
  const [processing, setProcessing] = React.useState(false)
  const [saving, setSaving] = React.useState(false)

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
    toast.success("Lead fields extracted — review and save")
  }

  async function handleSaveLead(e: React.FormEvent) {
    e.preventDefault()
    if (!customerName.trim()) {
      toast.error("Customer name is required")
      return
    }
    if (phone.trim().length < 5) {
      toast.error("Enter a valid phone number (at least 5 characters)")
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
      toast.success("Sent for approval — approve in Slack to save")
      setRaw("")
      setCustomerName("")
      setPhone("")
      setCarInfo("")
      setService("")
      router.refresh()
      return
    }

    toast.error(res.error)
  }

  return (
    <Card className="border-border/80 shadow-sm transition-shadow duration-200">
      <CardHeader className="border-b border-border/60 pb-4">
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary ring-1 ring-primary/25">
            <Sparkles className="size-5" aria-hidden />
          </div>
          <div className="min-w-0 space-y-1">
            <CardTitle className="text-lg font-semibold tracking-tight">
              AI Lead
            </CardTitle>
            <CardDescription>
              Paste a messy note (SMS, walk-in, voicemail, thread). Nothing is
              sent until you click{" "}
              <span className="font-medium text-foreground">Process</span>
              {" — "}Claude + LangChain fill name, phone, vehicle, and
              service; then confirm and save.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="grid gap-6 pt-6">
        <div className="grid gap-2">
          <Label htmlFor="ai-raw-note">Raw note</Label>
          <Textarea
            id="ai-raw-note"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            autoComplete="off"
            spellCheck
            placeholder={`e.g. "hey its mike - 5551029922 got a white 2019 f150 need full detail inside and out before sat thx"`}
            rows={8}
            className="min-h-[180px] resize-y font-mono text-sm leading-relaxed"
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            onClick={handleProcess}
            disabled={processing || !raw.trim()}
            className="gap-2 transition-transform duration-200 active:scale-[0.99]"
          >
            {processing ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden />
                Processing…
              </>
            ) : (
              <>
                <Wand2 className="size-4" aria-hidden />
                Process
              </>
            )}
          </Button>
        </div>

        <form className="grid gap-4 rounded-xl border border-border/60 bg-muted/20 p-4" onSubmit={handleSaveLead}>
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            Extracted fields — edit if needed
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2 sm:col-span-1">
              <Label htmlFor="ai-customer">Customer name</Label>
              <Input
                id="ai-customer"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                autoComplete="name"
                placeholder="Mike Torres"
              />
            </div>
            <div className="grid gap-2 sm:col-span-1">
              <Label htmlFor="ai-phone">Phone</Label>
              <Input
                id="ai-phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                type="tel"
                autoComplete="tel"
                placeholder="(555) 102-9922"
              />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ai-car">Car info</Label>
            <Input
              id="ai-car"
              value={carInfo}
              onChange={(e) => setCarInfo(e.target.value)}
              placeholder="2019 Ford F-150 — white"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ai-service">Service requested</Label>
            <Textarea
              id="ai-service"
              value={service}
              onChange={(e) => setService(e.target.value)}
              placeholder="Full exterior + interior before Saturday"
              rows={3}
              className="resize-y"
            />
            <p className="text-xs text-muted-foreground">
              Maps to Claude&apos;s{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
                service
              </code>{" "}
              field; saved as pin-point notes on the lead.
            </p>
          </div>
          <Button
            type="submit"
            disabled={saving || !customerName.trim() || phone.trim().length < 5}
            className="w-full sm:w-auto transition-transform duration-200 active:scale-[0.99]"
          >
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden />
                Saving…
              </>
            ) : (
              "Save lead"
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

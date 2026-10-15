"use client"

import * as React from "react"
import { Plus } from "lucide-react"
import { toast } from "sonner"

import { createLead, type CreateLeadResult } from "@/app/actions/leads"
import type { LeadStatus } from "@/lib/types/database"
import { FormField } from "@/components/gradia/form-field"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"

const statusOptions: { value: LeadStatus; label: string }[] = [
  { value: "new", label: "New" },
  { value: "quoted", label: "Quoted" },
  { value: "booked", label: "Booked" },
]

export function AddLeadDialog() {
  const [open, setOpen] = React.useState(false)
  const [pending, setPending] = React.useState(false)
  const [status, setStatus] = React.useState<LeadStatus>("new")

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const formData = new FormData(form)

    const payload = {
      customerName: String(formData.get("customerName") ?? ""),
      phone: String(formData.get("phone") ?? ""),
      carInfo: String(formData.get("carInfo") ?? "") || null,
      pinNotes: String(formData.get("pinNotes") ?? "") || null,
      status,
    }

    setPending(true)
    const result: CreateLeadResult = await createLead(payload)
    setPending(false)

    if (result.ok) {
      toast.success("Sent for approval — it's waiting in Approvals.")
      setOpen(false)
      form.reset()
      setStatus("new")
      return
    }

    toast.error(result.error)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button className="min-h-11 gap-2" />
        }
      >
        <Plus className="size-4" aria-hidden />
        Quick add lead
      </DialogTrigger>
      <DialogContent className="border-border/80 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add lead</DialogTitle>
          <DialogDescription>
            Log a walk-in or phone inquiry. We&apos;ll save it to our pipeline.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={handleSubmit}>
          <input type="hidden" name="status" value={status} readOnly />
          <FormField id="customerName" label="Customer">
            <Input
              name="customerName"
              autoComplete="name"
              placeholder="Alex Rivera"
              required
            />
          </FormField>
          <FormField id="phone" label="Phone">
            <Input
              name="phone"
              type="tel"
              autoComplete="tel"
              placeholder="+1 (555) 010-2030"
              required
            />
          </FormField>
          <FormField id="carInfo" label="Vehicle">
            <Input
              name="carInfo"
              placeholder="2021 Tesla Model Y — white"
            />
          </FormField>
          <FormField id="pinNotes" label="Pin-point notes">
            <Textarea
              name="pinNotes"
              placeholder="Paint correction on hood, pet hair in rear…"
              rows={3}
              className="resize-none"
            />
          </FormField>
          <div className="grid gap-2">
            <Label htmlFor="lead-status-select">Status</Label>
            <Select
              value={status}
              onValueChange={(value) => setStatus(value as LeadStatus)}
            >
              <SelectTrigger
                id="lead-status-select"
                className="w-full"
                size="default"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {statusOptions.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              className="min-h-11"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={pending}
              className="min-h-11"
            >
              {pending ? "Saving…" : "Save lead"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

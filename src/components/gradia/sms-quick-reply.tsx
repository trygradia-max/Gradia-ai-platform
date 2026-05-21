"use client"

import * as React from "react"
import { Loader2, MessageSquare, Send } from "lucide-react"
import { toast } from "sonner"

import { sendOperatorSms } from "@/app/actions/outbound-sms"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"

const MAX_CHARS = 1600

export function SmsQuickReply({
  toPhone,
  customerName,
}: {
  toPhone: string
  customerName: string | null
}) {
  const [body, setBody] = React.useState("")
  const [pending, setPending] = React.useState(false)

  async function handleSend(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setPending(true)
    const result = await sendOperatorSms({ to_phone: toPhone, body })
    setPending(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setBody("")
    toast.success("Text sent.")
  }

  return (
    <Card className="border-border/80">
      <CardHeader className="flex flex-row items-center gap-3 space-y-0">
        <div className="flex size-10 items-center justify-center rounded-lg bg-muted/60">
          <MessageSquare className="size-5 text-primary" aria-hidden />
        </div>
        <div>
          <CardTitle className="text-base font-medium">Quick reply</CardTitle>
          <p className="text-sm text-muted-foreground">
            Text {customerName?.trim() || toPhone} straight from here — no
            HITL cycle, since we&apos;re sending it ourselves.
          </p>
        </div>
      </CardHeader>
      <CardContent>
        <form className="grid gap-3" onSubmit={handleSend}>
          <div className="grid gap-2">
            <Label htmlFor="quick-reply-body">Message</Label>
            <Textarea
              id="quick-reply-body"
              value={body}
              onChange={(e) => setBody(e.target.value.slice(0, MAX_CHARS))}
              rows={4}
              placeholder="Hey — thanks for reaching out. We can fit you in this weekend, want me to send some times?"
            />
            <p className="text-xs text-muted-foreground">
              {body.length} / {MAX_CHARS} characters
            </p>
          </div>
          <div className="flex items-center justify-end">
            <Button
              type="submit"
              disabled={pending || !body.trim()}
              className="h-11 w-full gap-2 sm:h-9 sm:w-auto"
            >
              {pending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Send className="size-4" aria-hidden />
              )}
              Send
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

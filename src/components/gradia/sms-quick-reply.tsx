"use client"

import * as React from "react"
import { Loader2, MessageSquare, Send } from "lucide-react"
import { toast } from "sonner"

import { sendOperatorSms } from "@/app/actions/outbound-sms"
import { MotionCard } from "@/components/gradia/motion/motion-card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

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

  const target = customerName?.trim() || toPhone
  const remaining = MAX_CHARS - body.length
  const lowOnRoom = remaining <= 80

  return (
    <MotionCard interactive={false} className="overflow-hidden p-5 sm:p-6">
      <header className="flex items-start gap-3 pb-4">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary ring-1 ring-primary/25">
          <MessageSquare className="size-[18px]" aria-hidden />
        </div>
        <div className="min-w-0 space-y-1">
          <p className="label-eyebrow text-muted-foreground/70">Quick reply</p>
          <h3 className="font-display text-lg leading-tight tracking-tight text-foreground">
            Text <span className="italic">{target}</span> from here.
          </h3>
          <p className="text-sm text-muted-foreground">
            Skip the HITL loop — this one goes out under your name the
            moment you hit send.
          </p>
        </div>
      </header>

      <form className="grid gap-3" onSubmit={handleSend}>
        <div className="grid gap-2">
          <Label
            htmlFor="quick-reply-body"
            className="label-eyebrow text-muted-foreground/70"
          >
            Message
          </Label>
          <Textarea
            id="quick-reply-body"
            value={body}
            onChange={(e) => setBody(e.target.value.slice(0, MAX_CHARS))}
            rows={4}
            placeholder="Hey — thanks for reaching out. We can fit you in this weekend, want me to send some times?"
            className="resize-y border-border/60 bg-background/60 focus-visible:border-primary/40"
          />
          <p
            className={cn(
              "text-xs tabular-nums",
              lowOnRoom
                ? "text-amber-600 dark:text-amber-400"
                : "text-muted-foreground"
            )}
          >
            {remaining} character{remaining === 1 ? "" : "s"} left
          </p>
        </div>
        <div className="flex items-center justify-end">
          <Button
            type="submit"
            disabled={pending || !body.trim()}
            size="lg"
            className="h-11 w-full gap-2 transition-transform duration-200 active:scale-[0.98] sm:h-10 sm:w-auto sm:px-5"
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Send className="size-4" aria-hidden />
            )}
            Send the text
          </Button>
        </div>
      </form>
    </MotionCard>
  )
}

"use client"

import * as React from "react"
import { Loader2, Send, Sparkles } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"

type Message = {
  role: "user" | "assistant"
  content: string
}

const SUGGESTED_QUESTIONS = [
  "How many leads came in this week?",
  "What's on the books in the next 7 days?",
  "Did anyone ask about ceramic coating recently?",
  "How are leads split across voice, email, and SMS this month?",
]

const INITIAL_GREETING: Message = {
  role: "assistant",
  content:
    "Hey — ask us about our leads, customers, schedule, or anything that's come through. We'll dig through what we have and give you the straight answer.",
}

export function BiChat() {
  const [messages, setMessages] = React.useState<Message[]>([INITIAL_GREETING])
  const [input, setInput] = React.useState("")
  const [pending, setPending] = React.useState(false)
  const scrollRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    })
  }, [messages])

  async function send(content: string) {
    const trimmed = content.trim()
    if (!trimmed || pending) return

    const next: Message[] = [
      ...messages,
      { role: "user", content: trimmed },
    ]
    setMessages(next)
    setInput("")
    setPending(true)

    // Strip the initial greeting before sending — the server agent doesn't
    // need it for context and it just bloats every turn.
    const wireHistory = next.filter((m) => m !== INITIAL_GREETING)

    try {
      const res = await fetch("/api/bi/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: wireHistory }),
      })
      const data = (await res.json()) as
        | { ok: true; reply: string; toolsUsed: string[] }
        | { ok: false; error: string }

      if (!data.ok) {
        toast.error(data.error)
        setMessages(next)
        return
      }

      setMessages([
        ...next,
        { role: "assistant", content: data.reply },
      ])
    } catch (err) {
      console.error("[bi-chat] fetch failed:", err)
      toast.error("We couldn't reach the server — try again.")
    } finally {
      setPending(false)
    }
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    void send(input)
  }

  function handleSuggestion(q: string) {
    void send(q)
  }

  return (
    <Card className="border-border/80">
      <CardContent className="grid gap-4 p-0">
        <div
          ref={scrollRef}
          className="max-h-[60vh] min-h-[40vh] overflow-y-auto px-4 py-5 sm:px-6"
        >
          <ul className="grid gap-4">
            {messages.map((msg, i) => (
              <li
                key={i}
                className={
                  msg.role === "user"
                    ? "flex justify-end"
                    : "flex items-start gap-3"
                }
              >
                {msg.role === "assistant" ? (
                  <div
                    className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary ring-1 ring-primary/30"
                    aria-hidden
                  >
                    <Sparkles className="size-3.5" />
                  </div>
                ) : null}
                <div
                  className={
                    msg.role === "user"
                      ? "max-w-[80%] whitespace-pre-line rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-sm text-primary-foreground"
                      : "max-w-[80%] whitespace-pre-line text-sm leading-relaxed text-foreground"
                  }
                >
                  {msg.content}
                </div>
              </li>
            ))}
            {pending ? (
              <li className="flex items-start gap-3">
                <div
                  className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary ring-1 ring-primary/30"
                  aria-hidden
                >
                  <Sparkles className="size-3.5" />
                </div>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  Digging through it…
                </div>
              </li>
            ) : null}
          </ul>
        </div>

        {messages.length === 1 ? (
          <div className="flex flex-wrap gap-2 px-4 pb-1 sm:px-6">
            {SUGGESTED_QUESTIONS.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => handleSuggestion(q)}
                disabled={pending}
                className="rounded-full border border-border/60 bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
              >
                {q}
              </button>
            ))}
          </div>
        ) : null}

        <form
          className="flex items-end gap-2 border-t border-border/60 px-4 py-3 sm:px-6"
          onSubmit={handleSubmit}
        >
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                void send(input)
              }
            }}
            placeholder="Ask anything about our shop…"
            rows={1}
            className="min-h-[44px] max-h-40 resize-none"
            disabled={pending}
          />
          <Button
            type="submit"
            disabled={pending || !input.trim()}
            className="gap-2"
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Send className="size-4" aria-hidden />
            )}
            <span className="sr-only">Send</span>
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

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
  /** Only set on the assistant message currently being filled. */
  pending?: boolean
  /** Status line shown while a tool is running (e.g. "Looking up leads…"). */
  status?: string | null
}

type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; name: string }
  | { type: "tool_end"; name: string; ok: boolean }
  | { type: "done" }
  | { type: "error"; message: string }

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

const TOOL_LABELS: Record<string, string> = {
  count_leads: "Counting leads",
  recent_leads: "Pulling recent leads",
  customer_count: "Counting customers",
  channel_volume: "Tallying channel volume",
  upcoming_appointments: "Checking the calendar",
  search_memory: "Searching our notes",
}

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? `Running ${name}`
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

    setInput("")
    setPending(true)

    // Capture conversation state synchronously so the wire payload
    // doesn't race the async setMessages update.
    const userMessage: Message = { role: "user", content: trimmed }
    const placeholder: Message = {
      role: "assistant",
      content: "",
      pending: true,
      status: "Digging through it…",
    }
    const baselineMessages = [...messages, userMessage]
    setMessages([...baselineMessages, placeholder])

    const wireHistory = baselineMessages
      .filter((m) => m !== INITIAL_GREETING)
      .map((m) => ({ role: m.role, content: m.content }))

    try {
      const res = await fetch("/api/bi/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: wireHistory }),
      })

      if (!res.ok || !res.body) {
        const errBody = await res.text()
        toast.error(errBody || `Server error (${res.status})`)
        setMessages(baselineMessages)
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      let assistantText = ""
      let currentStatus: string | null = "Thinking…"
      let receivedError: string | null = null

      const flush = () => {
        setMessages((prev) => {
          const next = [...prev]
          const lastIdx = next.length - 1
          const last = next[lastIdx]
          if (last && last.role === "assistant" && last.pending) {
            next[lastIdx] = {
              ...last,
              content: assistantText,
              status: assistantText ? null : currentStatus,
            }
          }
          return next
        })
      }

      readLoop: while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        let sep = buffer.indexOf("\n\n")
        while (sep !== -1) {
          const eventChunk = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          const dataLine = eventChunk
            .split("\n")
            .find((line) => line.startsWith("data:"))
          if (!dataLine) {
            sep = buffer.indexOf("\n\n")
            continue
          }
          let event: AgentEvent
          try {
            event = JSON.parse(dataLine.slice(5).trim()) as AgentEvent
          } catch {
            sep = buffer.indexOf("\n\n")
            continue
          }

          if (event.type === "text_delta") {
            assistantText += event.text
            currentStatus = null
            flush()
          } else if (event.type === "tool_start") {
            currentStatus = `${toolLabel(event.name)}…`
            flush()
          } else if (event.type === "tool_end") {
            currentStatus = assistantText ? null : "Writing it up…"
            flush()
          } else if (event.type === "done") {
            currentStatus = null
            flush()
            break readLoop
          } else if (event.type === "error") {
            receivedError = event.message
            break readLoop
          }

          sep = buffer.indexOf("\n\n")
        }
      }

      // Finalize the assistant message — clear pending state.
      setMessages((prev) => {
        const next = [...prev]
        const lastIdx = next.length - 1
        const last = next[lastIdx]
        if (last && last.role === "assistant" && last.pending) {
          if (receivedError && !assistantText) {
            // Drop the empty placeholder; the toast surfaces the error.
            next.pop()
          } else {
            next[lastIdx] = {
              role: "assistant",
              content:
                assistantText ||
                receivedError ||
                "We've got nothing to add.",
            }
          }
        }
        return next
      })

      if (receivedError && !assistantText) {
        toast.error(receivedError)
      }
    } catch (err) {
      console.error("[bi-chat] stream failed:", err)
      toast.error("We couldn't reach the server — try again.")
      setMessages((prev) => {
        const next = [...prev]
        if (next[next.length - 1]?.pending) next.pop()
        return next
      })
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
                <div className="max-w-[80%]">
                  {msg.content ? (
                    <div
                      className={
                        msg.role === "user"
                          ? "whitespace-pre-line rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-sm text-primary-foreground"
                          : "whitespace-pre-line text-sm leading-relaxed text-foreground"
                      }
                    >
                      {msg.content}
                      {msg.pending ? (
                        <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse bg-primary/40" />
                      ) : null}
                    </div>
                  ) : null}
                  {msg.role === "assistant" && msg.status ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2
                        className="size-3.5 animate-spin"
                        aria-hidden
                      />
                      {msg.status}
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
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

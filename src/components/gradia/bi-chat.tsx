"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  AnimatePresence,
  motion,
  useReducedMotion,
  type Variants,
} from "framer-motion"
import { Loader2, Plus, Send, Sparkles } from "lucide-react"
import { toast } from "sonner"

import { BiChatHistorySheet } from "@/components/gradia/bi-chat-history-sheet"
import { MotionCard } from "@/components/gradia/motion/motion-card"
import { EASE_OUT_EXPO } from "@/components/gradia/motion/page-stagger"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

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

type WireEvent =
  | AgentEvent
  | { type: "conversation_id"; id: string }

export type InitialChatState = {
  conversationId: string | null
  messages: Pick<Message, "role" | "content">[]
}

const SUGGESTED_QUESTIONS = [
  "What should we set up next?",
  "How many leads came in this week?",
  "What's on the books in the next 7 days?",
  "Did anyone ask about ceramic coating recently?",
  "How are leads split across voice, email, and SMS this month?",
]

const GREETING: Message = {
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
  search_knowledge: "Reading our shop notes",
  revenue_in_window: "Tallying revenue",
  top_heat_leads: "Scoring our hottest leads",
  check_setup_status: "Checking what's wired up",
  recommend_next_setup: "Picking the next move",
  link_to_setup: "Finding the right page",
  preview_outreach: "Sizing up the audience",
  stage_outreach: "Staging drafts for approval",
}

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? `Running ${name.replace(/_/g, " ")}`
}

const messageEnter: Variants = {
  hidden: { opacity: 0, y: 10 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.4, ease: EASE_OUT_EXPO },
  },
}

const chipContainer: Variants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.05, delayChildren: 0.1 },
  },
}

const chipItem: Variants = {
  hidden: { opacity: 0, y: 6 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.35, ease: EASE_OUT_EXPO },
  },
}

export function BiChat({
  initial,
  endpoint = "/api/bi/chat",
}: {
  initial: InitialChatState
  /** Which chat backend to stream from. Defaults to Ask Gradia (read-only);
   *  the Gradia Agent box passes "/api/agent/chat" (read + stage outreach). */
  endpoint?: string
}) {
  const router = useRouter()
  const reduce = useReducedMotion()
  const [conversationId, setConversationId] = React.useState<string | null>(
    initial.conversationId
  )
  const [messages, setMessages] = React.useState<Message[]>(
    initial.messages.length > 0
      ? initial.messages.map((m) => ({ role: m.role, content: m.content }))
      : []
  )
  const [input, setInput] = React.useState("")
  const [pending, setPending] = React.useState(false)
  const scrollRef = React.useRef<HTMLDivElement | null>(null)

  // Parent passes a `key` based on the active conversation so the
  // component remounts on route switch (idiomatic React reset, no
  // setState-in-effect needed).

  React.useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: reduce ? "auto" : "smooth",
    })
  }, [messages, reduce])

  const isEmpty = messages.length === 0

  function startNewChat() {
    if (pending) return
    setConversationId(null)
    setMessages([])
    setInput("")
    // Drop the ?c=<id> param so a reload doesn't snap back to the
    // previous thread. router.replace keeps it cheap (no history entry).
    router.replace("/chat")
  }

  async function send(content: string) {
    const trimmed = content.trim()
    if (!trimmed || pending) return

    setInput("")
    setPending(true)

    const userMessage: Message = { role: "user", content: trimmed }
    const placeholder: Message = {
      role: "assistant",
      content: "",
      pending: true,
      status: "Digging through it…",
    }
    const baselineMessages = [...messages, userMessage]
    setMessages([...baselineMessages, placeholder])

    const wireHistory = baselineMessages.map((m) => ({
      role: m.role,
      content: m.content,
    }))

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversation_id: conversationId,
          messages: wireHistory,
        }),
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
          let event: WireEvent
          try {
            event = JSON.parse(dataLine.slice(5).trim()) as WireEvent
          } catch {
            sep = buffer.indexOf("\n\n")
            continue
          }

          if (event.type === "conversation_id") {
            setConversationId(event.id)
          } else if (event.type === "text_delta") {
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

      setMessages((prev) => {
        const next = [...prev]
        const lastIdx = next.length - 1
        const last = next[lastIdx]
        if (last && last.role === "assistant" && last.pending) {
          if (receivedError && !assistantText) {
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

  const displayedMessages = isEmpty ? [GREETING] : messages

  return (
    <MotionCard
      interactive={false}
      className="overflow-hidden p-0"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border/40 px-4 py-2.5 sm:px-6">
        <div className="flex items-center gap-2">
          <p className="label-eyebrow text-muted-foreground/70">Chat</p>
          {pending ? (
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground/70">
              <TypingDots />
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          <BiChatHistorySheet currentConversationId={conversationId} />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={startNewChat}
            disabled={pending || isEmpty}
            className="gap-1.5 text-xs"
          >
            <Plus className="size-3.5" aria-hidden />
            New chat
          </Button>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="max-h-[55dvh] min-h-[38dvh] overflow-y-auto px-4 py-6 sm:px-6"
      >
        <ul className="grid gap-5">
          <AnimatePresence initial={false}>
            {displayedMessages.map((msg, i) => (
              <MessageRow
                key={`${msg.role}-${i}`}
                msg={msg}
                reduce={reduce ?? false}
              />
            ))}
          </AnimatePresence>
        </ul>
      </div>

      {isEmpty ? (
        <motion.div
          variants={reduce ? undefined : chipContainer}
          initial={reduce ? undefined : "hidden"}
          animate={reduce ? undefined : "show"}
          className="flex flex-wrap gap-2 px-4 pb-2 sm:px-6"
        >
          {SUGGESTED_QUESTIONS.map((q) => (
            <motion.button
              key={q}
              variants={reduce ? undefined : chipItem}
              type="button"
              onClick={() => handleSuggestion(q)}
              disabled={pending}
              whileHover={reduce ? undefined : { y: -2 }}
              transition={{
                type: "spring",
                stiffness: 400,
                damping: 28,
              }}
              className="rounded-full border border-border/60 bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-border hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            >
              {q}
            </motion.button>
          ))}
        </motion.div>
      ) : null}

      <form
        className="flex items-end gap-2 border-t border-border/40 bg-muted/10 px-4 py-3 sm:px-6"
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
          className="min-h-[44px] max-h-40 resize-none border-border/60 bg-background/60 text-sm focus-visible:border-primary/40"
          disabled={pending}
        />
        <Button
          type="submit"
          disabled={pending || !input.trim()}
          className="h-11 gap-2 px-4 transition-transform duration-200 active:scale-[0.98]"
        >
          {pending ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Send className="size-4" aria-hidden />
          )}
          <span className="sr-only">Send</span>
        </Button>
      </form>
    </MotionCard>
  )
}

function MessageRow({ msg, reduce }: { msg: Message; reduce: boolean }) {
  const isUser = msg.role === "user"
  return (
    <motion.li
      variants={reduce ? undefined : messageEnter}
      initial={reduce ? false : "hidden"}
      animate="show"
      exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8 }}
      className={cn(
        isUser ? "flex justify-end" : "flex items-start gap-3"
      )}
    >
      {!isUser ? <AssistantAvatar pending={Boolean(msg.pending)} /> : null}
      <div className="min-w-0 max-w-[82%] space-y-1.5">
        {msg.content ? (
          <div
            className={cn(
              "whitespace-pre-line",
              isUser
                ? "rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-sm text-primary-foreground shadow-sm"
                : "text-sm leading-relaxed text-foreground"
            )}
          >
            {renderInlineLinks(msg.content, isUser)}
            {msg.pending ? (
              <motion.span
                aria-hidden
                animate={{ opacity: [1, 0.2, 1] }}
                transition={{
                  duration: 1.1,
                  repeat: Infinity,
                  ease: "easeInOut",
                }}
                className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 rounded-sm bg-primary/50"
              />
            ) : null}
          </div>
        ) : null}
        {!isUser && msg.status ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <TypingDots />
            <span>{msg.status}</span>
          </div>
        ) : null}
      </div>
    </motion.li>
  )
}

function AssistantAvatar({ pending }: { pending: boolean }) {
  return (
    <div className="relative mt-0.5 shrink-0" aria-hidden>
      <div className="flex size-7 items-center justify-center rounded-full bg-primary/12 text-primary ring-1 ring-primary/25">
        <Sparkles className="size-3.5" />
      </div>
      {pending ? (
        <motion.span
          aria-hidden
          className="absolute inset-0 rounded-full bg-primary/30"
          animate={{ scale: [1, 1.9], opacity: [0.45, 0] }}
          transition={{
            duration: 1.8,
            repeat: Infinity,
            ease: "easeOut",
          }}
        />
      ) : null}
    </div>
  )
}

/**
 * Renders message text with two kinds of links turned into real
 * elements:
 *   1. Markdown: [label](path)   — produced by the link_to_setup tool
 *   2. Bare relative paths:      /settings#voice, /approvals, etc.
 *
 * Only paths that start with "/" become links — never external URLs,
 * since the agent shouldn't ever be sending users off-platform. User
 * bubbles render plain text only (no point linking what the operator
 * just typed).
 */
function renderInlineLinks(
  text: string,
  isUserBubble: boolean
): React.ReactNode {
  if (isUserBubble || !text) return text

  // One regex with two alternatives so we walk the string once.
  // [label](/path)  →  group 1 + 2
  // bare /path      →  group 3
  const linkPattern =
    /\[([^\]]+)\]\((\/[^\s)]+)\)|(\/(?:settings|approvals|leads|customers|schedule|chat|agents|dashboard|onboarding)(?:[#/?][^\s)]*)?)/g

  const nodes: React.ReactNode[] = []
  let cursor = 0
  let key = 0

  for (const match of text.matchAll(linkPattern)) {
    const start = match.index ?? 0
    if (start > cursor) {
      nodes.push(text.slice(cursor, start))
    }
    const mdLabel = match[1]
    const mdPath = match[2]
    const barePath = match[3]
    if (mdLabel && mdPath) {
      nodes.push(<ChatLink key={`l${key++}`} href={mdPath} label={mdLabel} />)
    } else if (barePath) {
      nodes.push(
        <ChatLink key={`l${key++}`} href={barePath} label={barePath} />
      )
    }
    cursor = start + match[0].length
  }
  if (cursor < text.length) {
    nodes.push(text.slice(cursor))
  }
  return nodes.length > 0 ? nodes : text
}

function ChatLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center rounded-md bg-primary/10 px-2 py-0.5 text-sm font-medium text-primary underline-offset-4 transition-colors hover:bg-primary/15 hover:underline"
    >
      {label}
    </Link>
  )
}

function TypingDots() {
  return (
    <span
      className="inline-flex items-center gap-[3px]"
      aria-label="Working"
      role="status"
    >
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="inline-block size-1.5 rounded-full bg-current"
          animate={{ opacity: [0.3, 1, 0.3], y: [0, -1, 0] }}
          transition={{
            duration: 1.1,
            repeat: Infinity,
            delay: i * 0.18,
            ease: "easeInOut",
          }}
        />
      ))}
    </span>
  )
}

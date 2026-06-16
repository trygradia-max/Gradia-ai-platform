"use client"

import { useRouter } from "next/navigation"
import { motion, useReducedMotion } from "framer-motion"
import { Loader2, Mic, Sparkles, Square } from "lucide-react"
import { toast } from "sonner"

import { openCommandBar } from "@/components/gradia/command-bar"
import { useWhisperRecorder } from "@/lib/use-whisper-recorder"
import { cn } from "@/lib/utils"

/**
 * The phone's daily-loop surface (FOCUS spec §4.1/§4.2): a persistent,
 * bottom-anchored composer with tap-to-talk as the primary affordance. The
 * detailer is at the car, not a desk — one thumb, hands-free.
 *
 *   - Tap the pill → open the Gradia Agent command bar (typed input).
 *   - Tap the mic → record; tap again to stop. Whisper routes the transcript
 *     through the same engine and reads back what it did.
 *
 * Mobile only — desktop drives the command bar from ⌘K / the top-bar button.
 */
export function MobileComposer() {
  const router = useRouter()
  const reduce = useReducedMotion()
  const { state, toggle } = useWhisperRecorder({
    onResult: ({ reply }) => {
      toast.success(reply, { duration: 6000 })
      router.refresh()
    },
    onError: (msg) => toast.error(msg),
  })

  const recording = state === "recording"
  const processing = state === "processing"
  const busy = recording || processing

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 sm:hidden">
      {/* Fade so content scrolling underneath doesn't collide with the bar. */}
      <div className="h-6 bg-gradient-to-t from-background to-transparent" />
      <div className="pointer-events-auto flex items-center gap-2 border-t border-border/60 bg-background/90 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur-md">
        <button
          type="button"
          onClick={() => openCommandBar()}
          disabled={busy}
          className={cn(
            "flex h-11 flex-1 items-center gap-2 rounded-full border border-border/60 bg-card/50 px-4 text-left text-sm text-muted-foreground transition-colors hover:border-border disabled:opacity-50"
          )}
          aria-label="Ask Gradia"
        >
          <Sparkles className="size-4 shrink-0 text-primary" aria-hidden />
          <span className="truncate">
            {recording
              ? "Listening — tap stop when you're done"
              : processing
                ? "Writing it up…"
                : "Tell Gradia what to do…"}
          </span>
        </button>

        <motion.button
          type="button"
          onClick={toggle}
          disabled={processing}
          aria-label={recording ? "Stop recording" : "Tap to talk"}
          animate={
            recording && !reduce ? { scale: [1, 1.08, 1] } : { scale: 1 }
          }
          transition={
            recording
              ? { duration: 1.4, repeat: Infinity, ease: "easeInOut" }
              : { duration: 0.3 }
          }
          className={cn(
            "flex size-11 shrink-0 items-center justify-center rounded-full ring-1 transition-colors active:scale-[0.97]",
            recording
              ? "bg-destructive text-destructive-foreground ring-destructive/40"
              : "bg-primary text-primary-foreground ring-primary/40"
          )}
        >
          {processing ? (
            <Loader2 className="size-5 animate-spin" aria-hidden />
          ) : recording ? (
            <Square className="size-4 fill-current" aria-hidden />
          ) : (
            <Mic className="size-5" aria-hidden />
          )}
        </motion.button>
      </div>
    </div>
  )
}

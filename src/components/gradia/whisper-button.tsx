"use client"

import { useRouter } from "next/navigation"
import { AnimatePresence, motion, useReducedMotion } from "framer-motion"
import { Loader2, Mic, Square } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { MotionCard } from "@/components/gradia/motion/motion-card"
import { EASE_OUT_EXPO } from "@/components/gradia/motion/page-stagger"
import { PulseDot } from "@/components/gradia/motion/pulse-dot"
import { SectionHeader } from "@/components/gradia/motion/section-header"
import { useWhisperRecorder } from "@/lib/use-whisper-recorder"
import { cn } from "@/lib/utils"

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}:${secs.toString().padStart(2, "0")}`
}

export function WhisperButton() {
  const router = useRouter()
  const reduce = useReducedMotion()
  // The agent already acted on the transcript (NOW-2) and wrote its own
  // read-back; we just surface its words and refresh.
  const { state, duration, start, stop } = useWhisperRecorder({
    onResult: ({ reply }) => {
      toast.success(reply, { duration: 6000 })
      router.refresh()
    },
    onError: (msg) => toast.error(msg),
  })

  const startRecording = () => void start()
  const stopRecording = () => stop()

  const isActive = state === "recording" || state === "processing"

  return (
    <section className="space-y-5">
      <SectionHeader
        eyebrow="Voice"
        title={
          <>
            <span className="italic">Say</span> the work.
          </>
        }
        subtitle="Tap once, talk like you would to a partner. We'll write it up and drop it in Approvals before anything goes out."
      />

      <MotionCard
        interactive={false}
        glow={isActive}
        className={cn(
          "relative overflow-hidden p-6 sm:p-8",
          isActive && "border-primary/40"
        )}
      >
        <AnimatePresence>
          {state === "recording" && !reduce ? (
            <motion.div
              key="halo"
              aria-hidden
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="pointer-events-none absolute inset-0"
            >
              <motion.div
                className="absolute -left-24 -top-24 size-64 rounded-full bg-primary/15 blur-3xl"
                animate={{ scale: [1, 1.15, 1], opacity: [0.45, 0.7, 0.45] }}
                transition={{
                  duration: 3.6,
                  repeat: Infinity,
                  ease: "easeInOut",
                }}
              />
              <motion.div
                className="absolute -bottom-24 -right-16 size-72 rounded-full bg-primary/10 blur-3xl"
                animate={{
                  scale: [1.05, 0.95, 1.05],
                  opacity: [0.35, 0.55, 0.35],
                }}
                transition={{
                  duration: 4.4,
                  repeat: Infinity,
                  ease: "easeInOut",
                  delay: 0.4,
                }}
              />
            </motion.div>
          ) : null}
        </AnimatePresence>

        <div className="relative flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-4">
            <motion.div
              animate={
                state === "recording" && !reduce
                  ? { scale: [1, 1.06, 1] }
                  : { scale: 1 }
              }
              transition={
                state === "recording"
                  ? { duration: 1.4, repeat: Infinity, ease: "easeInOut" }
                  : { duration: 0.4, ease: EASE_OUT_EXPO }
              }
              className={cn(
                "flex size-12 shrink-0 items-center justify-center rounded-xl ring-1 transition-colors",
                isActive
                  ? "bg-primary/15 text-primary ring-primary/30"
                  : "bg-primary/10 text-primary ring-primary/20"
              )}
            >
              {state === "processing" ? (
                <Loader2 className="size-5 animate-spin" aria-hidden />
              ) : (
                <Mic className="size-5" aria-hidden />
              )}
            </motion.div>
            <div className="min-w-0 space-y-1.5">
              <div className="flex items-center gap-2">
                <p className="label-eyebrow text-muted-foreground/70">
                  {state === "recording"
                    ? "Listening"
                    : state === "processing"
                      ? "Writing it up"
                      : state === "requesting"
                        ? "Mic check"
                        : "Ready when you are"}
                </p>
                {isActive ? <PulseDot tone="accent" size={6} /> : null}
              </div>
              <p className="font-display text-xl text-foreground sm:text-2xl">
                {state === "recording" ? (
                  <span className="tabular-nums">{formatTime(duration)}</span>
                ) : state === "processing" ? (
                  <>Pulling out the details…</>
                ) : (
                  <>
                    Tell us what just{" "}
                    <span className="italic">happened</span>.
                  </>
                )}
              </p>
              <p className="max-w-prose text-sm text-muted-foreground">
                {state === "recording"
                  ? "Keep going — we'll keep up. Tap stop when you're done."
                  : "A walk-in, a price you quoted, a note for a regular. Anything that needs to land in the system."}
              </p>
            </div>
          </div>

          <div className="shrink-0 sm:self-center">
            {state === "idle" ? (
              <Button
                type="button"
                onClick={startRecording}
                size="lg"
                className="h-12 gap-2 px-5 transition-transform duration-200 active:scale-[0.98]"
              >
                <Mic className="size-4" aria-hidden />
                Tap to talk
              </Button>
            ) : state === "requesting" ? (
              <Button
                type="button"
                disabled
                size="lg"
                className="h-12 gap-2 px-5"
              >
                <Loader2 className="size-4 animate-spin" aria-hidden />
                Asking for mic…
              </Button>
            ) : state === "recording" ? (
              <Button
                type="button"
                onClick={stopRecording}
                variant="destructive"
                size="lg"
                className="h-12 gap-2 px-5 transition-transform duration-200 active:scale-[0.98]"
              >
                <Square className="size-4 fill-current" aria-hidden />
                Stop &amp; send
              </Button>
            ) : (
              <Button
                type="button"
                disabled
                size="lg"
                className="h-12 gap-2 px-5"
              >
                <Loader2 className="size-4 animate-spin" aria-hidden />
                Writing it up…
              </Button>
            )}
          </div>
        </div>
      </MotionCard>
    </section>
  )
}

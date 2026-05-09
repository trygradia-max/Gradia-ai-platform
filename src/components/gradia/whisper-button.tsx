"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Loader2, Mic } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"

type RecordingState = "idle" | "requesting" | "recording" | "processing"

function pickMimeType(): string {
  if (typeof window === "undefined" || typeof MediaRecorder === "undefined") {
    return ""
  }
  if (MediaRecorder.isTypeSupported("audio/webm")) return "audio/webm"
  if (MediaRecorder.isTypeSupported("audio/mp4")) return "audio/mp4"
  if (MediaRecorder.isTypeSupported("audio/ogg")) return "audio/ogg"
  return ""
}

function fileExtFor(mime: string): string {
  if (mime.includes("mp4")) return "m4a"
  if (mime.includes("ogg")) return "ogg"
  return "webm"
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}:${secs.toString().padStart(2, "0")}`
}

export function WhisperButton() {
  const router = useRouter()
  const [state, setState] = React.useState<RecordingState>("idle")
  const [duration, setDuration] = React.useState(0)
  const recorderRef = React.useRef<MediaRecorder | null>(null)
  const chunksRef = React.useRef<Blob[]>([])
  const streamRef = React.useRef<MediaStream | null>(null)
  const timerRef = React.useRef<ReturnType<typeof setInterval> | null>(null)
  const mimeRef = React.useRef<string>("")

  React.useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop())
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [])

  async function startRecording() {
    if (typeof navigator === "undefined" || !navigator.mediaDevices) {
      toast.error("Mic isn't available in this browser.")
      return
    }
    const mimeType = pickMimeType()
    if (!mimeType) {
      toast.error("Mic recording isn't supported in this browser.")
      return
    }

    setState("requesting")
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const recorder = new MediaRecorder(stream, { mimeType })
      recorderRef.current = recorder
      chunksRef.current = []
      mimeRef.current = mimeType

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }

      recorder.onstop = async () => {
        streamRef.current?.getTracks().forEach((t) => t.stop())
        streamRef.current = null
        if (timerRef.current) {
          clearInterval(timerRef.current)
          timerRef.current = null
        }

        const blob = new Blob(chunksRef.current, { type: mimeRef.current })
        await processBlob(blob)
      }

      recorder.start(250)
      setState("recording")
      setDuration(0)
      timerRef.current = setInterval(() => {
        setDuration((d) => d + 1)
      }, 1000)
    } catch (err) {
      console.error("[whisper] mic permission denied or failed:", err)
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
      setState("idle")
      toast.error("We need mic access — enable it in your browser.")
    }
  }

  function stopRecording() {
    const rec = recorderRef.current
    if (rec && rec.state !== "inactive") {
      setState("processing")
      rec.stop()
    }
  }

  async function processBlob(blob: Blob) {
    const ext = fileExtFor(mimeRef.current)
    const formData = new FormData()
    formData.append("audio", blob, `whisper.${ext}`)

    try {
      const res = await fetch("/api/whisper/process", {
        method: "POST",
        body: formData,
      })
      const result = (await res.json()) as
        | { ok: true; intent: "create_lead" | "add_note"; transcript: string }
        | { ok: false; error: string; transcript?: string }

      if (!result.ok) {
        toast.error(result.error)
        setState("idle")
        return
      }

      const intentLabel = result.intent === "add_note" ? "note" : "lead"
      toast.success(`Sent for approval — review the ${intentLabel} in Slack or Approvals`)
      router.refresh()
    } catch (err) {
      console.error("[whisper] upload failed:", err)
      toast.error("Couldn't reach the server — try again.")
    } finally {
      setState("idle")
    }
  }

  return (
    <Card className="border-border/80 shadow-sm transition-shadow duration-200">
      <CardContent className="grid gap-4 p-6">
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary ring-1 ring-primary/25">
            <Mic className="size-5" aria-hidden />
          </div>
          <div className="min-w-0 space-y-1">
            <p className="text-base font-semibold tracking-tight">Talk to us</p>
            <p className="text-sm text-muted-foreground">
              Tap and tell us what just happened — log a lead, leave a note, or queue a booking. We&apos;ll ping you to approve.
            </p>
          </div>
        </div>

        {state === "idle" ? (
          <Button
            type="button"
            onClick={startRecording}
            className="h-12 gap-2 transition-transform duration-200 active:scale-[0.99]"
          >
            <Mic className="size-5" aria-hidden />
            Tap to talk
          </Button>
        ) : state === "requesting" ? (
          <Button type="button" disabled className="h-12 gap-2">
            <Loader2 className="size-5 animate-spin" aria-hidden />
            Asking for mic…
          </Button>
        ) : state === "recording" ? (
          <Button
            type="button"
            onClick={stopRecording}
            variant="destructive"
            className="h-12 gap-2 transition-transform duration-200 active:scale-[0.99]"
          >
            <span className="relative flex size-3">
              <span
                className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-75"
                aria-hidden
              />
              <span
                className="relative inline-flex size-3 rounded-full bg-white"
                aria-hidden
              />
            </span>
            Recording · {formatTime(duration)} — tap to stop
          </Button>
        ) : (
          <Button type="button" disabled className="h-12 gap-2">
            <Loader2 className="size-5 animate-spin" aria-hidden />
            Listening… we&apos;re parsing what we heard
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

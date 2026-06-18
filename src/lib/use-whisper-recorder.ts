"use client"

import * as React from "react"

/**
 * Shared mic-capture hook behind every Whisper surface (the Home "Say the work"
 * card and the mobile command composer). Owns the MediaRecorder lifecycle and
 * the POST to /api/whisper/process; the caller decides how to surface the
 * agent's read-back. Keeping this in one place means voice behaves identically
 * everywhere — one engine, one recorder.
 */

export type RecordingState = "idle" | "requesting" | "recording" | "processing"

export type WhisperResponse =
  | { ok: true; transcript: string; reply: string; tools: string[] }
  | { ok: false; error: string; transcript?: string }

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

export function useWhisperRecorder({
  onResult,
  onError,
}: {
  /** The agent already acted; `reply` is its read-back for the owner. */
  onResult: (result: { reply: string; transcript: string }) => void
  onError: (message: string) => void
}) {
  const [state, setState] = React.useState<RecordingState>("idle")
  const [duration, setDuration] = React.useState(0)
  const recorderRef = React.useRef<MediaRecorder | null>(null)
  const chunksRef = React.useRef<Blob[]>([])
  const streamRef = React.useRef<MediaStream | null>(null)
  const timerRef = React.useRef<ReturnType<typeof setInterval> | null>(null)
  const mimeRef = React.useRef<string>("")

  // Stable callback refs so the recorder's onstop always sees the latest
  // handlers without re-subscribing.
  const onResultRef = React.useRef(onResult)
  const onErrorRef = React.useRef(onError)
  React.useEffect(() => {
    onResultRef.current = onResult
    onErrorRef.current = onError
  }, [onResult, onError])

  React.useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop())
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [])

  const processBlob = React.useCallback(async (blob: Blob) => {
    const ext = fileExtFor(mimeRef.current)
    const formData = new FormData()
    formData.append("audio", blob, `whisper.${ext}`)
    try {
      const res = await fetch("/api/whisper/process", {
        method: "POST",
        body: formData,
      })
      const result = (await res.json()) as WhisperResponse
      if (!result.ok) {
        onErrorRef.current(result.error)
        return
      }
      onResultRef.current({
        reply: result.reply || "Got it.",
        transcript: result.transcript,
      })
    } catch (err) {
      console.error("[whisper] upload failed:", err)
      onErrorRef.current("Couldn't reach the server — try again.")
    } finally {
      setState("idle")
    }
  }, [])

  const start = React.useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices) {
      onErrorRef.current("Mic isn't available in this browser.")
      return
    }
    const mimeType = pickMimeType()
    if (!mimeType) {
      onErrorRef.current("Mic recording isn't supported in this browser.")
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
      timerRef.current = setInterval(() => setDuration((d) => d + 1), 1000)
    } catch (err) {
      console.error("[whisper] mic permission denied or failed:", err)
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
      setState("idle")
      onErrorRef.current("We need mic access — enable it in your browser.")
    }
  }, [processBlob])

  const stop = React.useCallback(() => {
    const rec = recorderRef.current
    if (rec && rec.state !== "inactive") {
      setState("processing")
      rec.stop()
    }
  }, [])

  const toggle = React.useCallback(() => {
    if (state === "recording") stop()
    else if (state === "idle") void start()
  }, [state, start, stop])

  return { state, duration, start, stop, toggle }
}

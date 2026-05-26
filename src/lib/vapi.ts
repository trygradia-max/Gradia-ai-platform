/**
 * Vapi REST API wrapper — server-only.
 *
 * Lets Gradia provision + manage a per-shop voice receptionist
 * programmatically instead of asking the operator to log into Vapi's
 * dashboard, build an assistant by hand, and paste the ID back into
 * Gradia.
 *
 * Auth model: one global Vapi account (VAPI_API_KEY in env). Every
 * shop's assistant lives on that account; we tag assistant.metadata
 * with the shop_id so we can audit ownership later.
 *
 * Docs: https://docs.vapi.ai/api-reference/assistants
 */

const VAPI_API_BASE = "https://api.vapi.ai"

export class VapiApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = "VapiApiError"
  }
}

function apiKey(): string {
  const v = process.env.VAPI_API_KEY?.trim()
  if (!v) {
    throw new VapiApiError(500, "VAPI_API_KEY is not configured")
  }
  return v
}

/** Curated voices we expose in the build form. Hand-picked for clarity
 *  + warmth on a phone call (8kHz codec — many studio voices muddy). */
export const VAPI_VOICE_OPTIONS: {
  id: VapiVoiceId
  label: string
  description: string
  provider: "11labs" | "openai" | "playht"
  /** Provider-specific voice id passed to Vapi. */
  voiceId: string
}[] = [
  {
    id: "warm-female",
    label: "Warm female",
    description: "Friendly Northeastern receptionist voice — good default.",
    provider: "11labs",
    voiceId: "rachel",
  },
  {
    id: "professional-female",
    label: "Professional female",
    description: "Crisp and confident — great for premium service shops.",
    provider: "11labs",
    voiceId: "bella",
  },
  {
    id: "warm-male",
    label: "Warm male",
    description: "Calm, attentive — reads as a thoughtful service advisor.",
    provider: "11labs",
    voiceId: "antoni",
  },
  {
    id: "neutral-male",
    label: "Neutral male",
    description: "Even-toned and direct — minimal personality coloring.",
    provider: "openai",
    voiceId: "onyx",
  },
]

export type VapiVoiceId =
  | "warm-female"
  | "professional-female"
  | "warm-male"
  | "neutral-male"

export function findVoiceOption(id: VapiVoiceId | string | null | undefined) {
  return (
    VAPI_VOICE_OPTIONS.find((v) => v.id === id) ?? VAPI_VOICE_OPTIONS[0]
  )
}

export type VapiAssistant = {
  id: string
  name: string
  firstMessage: string | null
  /** Echoed metadata.shop_id if we set it during create. */
  shopId: string | null
}

type RawAssistant = {
  id?: string
  name?: string
  firstMessage?: string | null
  metadata?: { shop_id?: string } | null
}

type AssistantBody = {
  name: string
  firstMessage: string
  systemPrompt: string
  /** Public server URL Vapi POSTs tool calls + end-of-call to. */
  serverUrl: string
  voice: VapiVoiceId
  /** Sticks shop_id on assistant.metadata for audit / lookup. */
  shopId: string
}

/** Building blocks shared by create + update. */
function assistantPayload(body: AssistantBody) {
  const voice = findVoiceOption(body.voice)
  return {
    name: body.name,
    firstMessage: body.firstMessage,
    firstMessageMode: "assistant-speaks-first",
    model: {
      provider: "openai",
      model: "gpt-4o-mini",
      // Vapi expects the system content as the first messages entry.
      messages: [
        {
          role: "system",
          content: body.systemPrompt,
        },
      ],
      // Tools are wired to the same server URL — Vapi delivers tool
      // calls into our /api/vapi/webhook handler which already exists.
    },
    voice: {
      provider: voice.provider,
      voiceId: voice.voiceId,
    },
    server: {
      url: body.serverUrl,
      // Wire delivery of these event types into our webhook so the
      // existing handler can dispatch to tool implementations + log
      // end-of-call summaries.
      serverMessages: [
        "tool-calls",
        "end-of-call-report",
        "status-update",
        "transcript",
        "hang",
      ],
    },
    metadata: {
      shop_id: body.shopId,
    },
    // Conservative VAD + barge-in settings — voice receptionists feel
    // worse when they overspeak. Operators can tweak later via Vapi
    // dashboard if they want.
    backgroundSound: "office",
    silenceTimeoutSeconds: 30,
    maxDurationSeconds: 600,
  }
}

async function vapiFetch<T>(input: {
  method: "GET" | "POST" | "PATCH" | "DELETE"
  path: string
  body?: unknown
}): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey()}`,
    Accept: "application/json",
  }
  let bodyText: string | undefined
  if (input.body !== undefined && input.method !== "GET") {
    bodyText = JSON.stringify(input.body)
    headers["Content-Type"] = "application/json"
  }

  const res = await fetch(`${VAPI_API_BASE}${input.path}`, {
    method: input.method,
    headers,
    body: bodyText,
  })
  const raw = await res.text()
  if (!res.ok) {
    throw new VapiApiError(
      res.status,
      `Vapi ${input.method} ${input.path} failed: ${raw.slice(0, 300)}`
    )
  }
  if (input.method === "DELETE" && !raw) return undefined as T
  try {
    return JSON.parse(raw) as T
  } catch {
    throw new VapiApiError(500, "Vapi response was not JSON")
  }
}

export async function createAssistant(body: AssistantBody): Promise<VapiAssistant> {
  const raw = await vapiFetch<RawAssistant>({
    method: "POST",
    path: "/assistant",
    body: assistantPayload(body),
  })
  if (!raw.id) {
    throw new VapiApiError(500, "Vapi did not return an assistant id")
  }
  return {
    id: raw.id,
    name: raw.name ?? body.name,
    firstMessage: raw.firstMessage ?? body.firstMessage,
    shopId: raw.metadata?.shop_id ?? body.shopId,
  }
}

export async function updateAssistant(
  assistantId: string,
  body: AssistantBody
): Promise<VapiAssistant> {
  const raw = await vapiFetch<RawAssistant>({
    method: "PATCH",
    path: `/assistant/${encodeURIComponent(assistantId)}`,
    body: assistantPayload(body),
  })
  return {
    id: assistantId,
    name: raw.name ?? body.name,
    firstMessage: raw.firstMessage ?? body.firstMessage,
    shopId: raw.metadata?.shop_id ?? body.shopId,
  }
}

export async function getAssistant(
  assistantId: string
): Promise<VapiAssistant | null> {
  try {
    const raw = await vapiFetch<RawAssistant>({
      method: "GET",
      path: `/assistant/${encodeURIComponent(assistantId)}`,
    })
    if (!raw.id) return null
    return {
      id: raw.id,
      name: raw.name ?? "Voice receptionist",
      firstMessage: raw.firstMessage ?? null,
      shopId: raw.metadata?.shop_id ?? null,
    }
  } catch (err) {
    if (err instanceof VapiApiError && err.status === 404) return null
    throw err
  }
}

export async function deleteAssistant(assistantId: string): Promise<void> {
  await vapiFetch<unknown>({
    method: "DELETE",
    path: `/assistant/${encodeURIComponent(assistantId)}`,
  })
}

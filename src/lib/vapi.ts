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

// Env-overridable so tests can point the executor at a mock server.
const VAPI_API_BASE = process.env.VAPI_API_BASE?.trim() || "https://api.vapi.ai"

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
  /** Per-shop webhook auth secret — sent back as x-vapi-secret. */
  serverSecret?: string | null
  voice: VapiVoiceId
  /** Sticks shop_id on assistant.metadata for audit / lookup. */
  shopId: string
}

/**
 * The five receptionist tools, declared on the assistant model so the LLM
 * can actually call them (without these the webhook dispatcher never
 * fires). Parameter names match what vapi-tools.ts readParam accepts.
 * HITL invariant lives in the handlers, not here: propose_booking and
 * capture_lead STAGE approvals; nothing executes from a call.
 */
export const VAPI_TOOL_DEFINITIONS = [
  {
    type: "function" as const,
    function: {
      name: "capture_lead",
      description:
        "Record a caller as a lead so the team follows up. Use for any inquiry that doesn't end in a booking proposal.",
      parameters: {
        type: "object",
        properties: {
          customer_name: { type: "string", description: "Caller's name" },
          phone: { type: "string", description: "Caller's phone, if offered" },
          vehicle: { type: "string", description: "Vehicle make/model/year" },
          service: { type: "string", description: "Service they asked about" },
          notes: { type: "string", description: "Anything else the team should know" },
        },
        required: ["customer_name"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "propose_booking",
      description:
        "Stage a booking proposal for human approval. Never tell the caller the slot is confirmed — the team texts to confirm.",
      parameters: {
        type: "object",
        properties: {
          customer_name: { type: "string" },
          phone: { type: "string" },
          service: { type: "string", description: "Service to book" },
          when: { type: "string", description: "Requested time in the caller's words" },
          iso_start_time: { type: "string", description: "ISO 8601 start time if determinable" },
          duration_minutes: { type: "string" },
          timezone: { type: "string" },
          vehicle: { type: "string" },
          notes: { type: "string" },
        },
        required: ["customer_name", "service", "when"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "quote_service",
      description: "Look up the exact price and duration for a service on our menu.",
      parameters: {
        type: "object",
        properties: {
          service: { type: "string", description: "Service name to look up" },
        },
        required: ["service"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "lookup_customer_history",
      description: "Find an existing customer's past services and notes by phone number.",
      parameters: {
        type: "object",
        properties: {
          phone: { type: "string", description: "Customer phone; defaults to the caller's number" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "lookup_shop_policy",
      description: "Search the shop's knowledge base for a policy or FAQ answer.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "The caller's question" },
        },
        required: ["question"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "reschedule_appointment",
      description:
        "Stage a reschedule request for human approval. Never tell the caller the move is confirmed — the team texts to confirm the new time.",
      parameters: {
        type: "object",
        properties: {
          customer_name: { type: "string" },
          phone: { type: "string", description: "Number on the booking; defaults to the caller's" },
          new_when: { type: "string", description: "Requested new time in the caller's words" },
          iso_new_start_time: { type: "string", description: "ISO 8601 new start time if determinable" },
        },
        required: ["new_when"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "cancel_appointment",
      description:
        "Stage a cancellation for human approval. Never tell the caller it's removed yet — the team confirms by text.",
      parameters: {
        type: "object",
        properties: {
          customer_name: { type: "string" },
          phone: { type: "string", description: "Number on the booking; defaults to the caller's" },
          reason: { type: "string", description: "Why they're cancelling, if offered" },
        },
      },
    },
  },
]

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
      tools: VAPI_TOOL_DEFINITIONS,
    },
    voice: {
      provider: voice.provider,
      voiceId: voice.voiceId,
    },
    server: {
      url: body.serverUrl,
      ...(body.serverSecret ? { secret: body.serverSecret } : {}),
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

// ---------- Phone numbers (BYO Twilio import) ----------

/**
 * Imports a Twilio number into Vapi for inbound voice routing.
 *
 * Per the vapi-voice-provider skill finding (2026-06-09): provider is
 * "twilio" (byo-phone-number is SIP trunks only) and smsEnabled MUST be
 * false — the default (true) overwrites the Twilio messaging webhook and
 * breaks the split (voice → Vapi, SMS → Gradia). Callers should still
 * verify the messaging webhook afterwards (belt and braces).
 */
export async function importTwilioNumber(input: {
  e164: string
  twilioAccountSid: string
  twilioAuthToken: string
  assistantId: string
  name: string
}): Promise<{ phoneNumberId: string }> {
  const raw = await vapiFetch<{ id?: string }>({
    method: "POST",
    path: "/phone-number",
    body: {
      provider: "twilio",
      number: input.e164,
      twilioAccountSid: input.twilioAccountSid,
      twilioAuthToken: input.twilioAuthToken,
      assistantId: input.assistantId,
      name: input.name,
      smsEnabled: false,
    },
  })
  if (!raw.id) {
    throw new VapiApiError(500, "Vapi did not return a phone-number id")
  }
  return { phoneNumberId: raw.id }
}

export async function deletePhoneNumber(phoneNumberId: string): Promise<void> {
  await vapiFetch<unknown>({
    method: "DELETE",
    path: `/phone-number/${encodeURIComponent(phoneNumberId)}`,
  })
}

// ---------- Outbound calls (test call) ----------

/** Rings `toNumber` from the shop's imported number with the assistant on
 *  the line — the launch-gate test call. */
export async function createOutboundCall(input: {
  assistantId: string
  phoneNumberId: string
  toNumber: string
}): Promise<{ callId: string }> {
  const raw = await vapiFetch<{ id?: string }>({
    method: "POST",
    path: "/call",
    body: {
      assistantId: input.assistantId,
      phoneNumberId: input.phoneNumberId,
      customer: { number: input.toNumber },
    },
  })
  if (!raw.id) {
    throw new VapiApiError(500, "Vapi did not return a call id")
  }
  return { callId: raw.id }
}

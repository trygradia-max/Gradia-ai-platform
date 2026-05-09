/**
 * OpenAI embeddings client for the shared memory layer (server-only).
 * One model, fixed dimensions — the dimension is baked into the
 * `interactions.embedding` column type, so changing it requires a migration.
 */

export const EMBEDDING_MODEL = "text-embedding-3-small"
export const EMBEDDING_DIMENSIONS = 1536

// Conservative cap below the 8192-token model limit. ~30k chars maps to
// ~7.5k tokens for English. Callers should chunk longer payloads (e.g.,
// per-turn for voice transcripts) rather than rely on this truncation.
const MAX_INPUT_CHARS = 30_000

const RETRY_MAX_ATTEMPTS = 4
const RETRY_BASE_MS = 500
const RETRY_CAP_MS = 8_000

function openaiKey(): string {
  const key = process.env.OPENAI_API_KEY?.trim()
  if (!key) {
    throw new Error("OPENAI_API_KEY is not configured")
  }
  return key
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function truncate(text: string): string {
  if (text.length <= MAX_INPUT_CHARS) return text
  return text.slice(0, MAX_INPUT_CHARS)
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504
}

type OpenAIEmbeddingResponse = {
  data?: Array<{ embedding: number[]; index: number }>
  error?: { message?: string }
}

async function callEmbeddings(input: string | string[]): Promise<number[][]> {
  const apiKey = openaiKey()
  const payload = JSON.stringify({
    model: EMBEDDING_MODEL,
    input,
  })

  let lastErr: unknown
  for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: payload,
      })

      if (!res.ok) {
        const body = await res.text()
        if (isTransientStatus(res.status) && attempt < RETRY_MAX_ATTEMPTS - 1) {
          lastErr = new Error(`OpenAI ${res.status}: ${body.slice(0, 200)}`)
          const delay = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_CAP_MS)
          await sleep(delay)
          continue
        }
        throw new Error(
          `OpenAI embeddings error (${res.status}): ${body.slice(0, 200)}`
        )
      }

      const data = (await res.json()) as OpenAIEmbeddingResponse
      const items = data.data
      if (!Array.isArray(items) || items.length === 0) {
        throw new Error("OpenAI returned no embedding data")
      }

      // Sort by index — API guarantees order matches input order, but be safe.
      const sorted = [...items].sort((a, b) => a.index - b.index)
      const vectors = sorted.map((item) => item.embedding)

      for (const v of vectors) {
        if (!Array.isArray(v) || v.length !== EMBEDDING_DIMENSIONS) {
          throw new Error(
            `Embedding shape invalid (got ${v?.length}, expected ${EMBEDDING_DIMENSIONS})`
          )
        }
      }
      return vectors
    } catch (err) {
      lastErr = err
      if (attempt === RETRY_MAX_ATTEMPTS - 1) {
        break
      }
      const delay = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_CAP_MS)
      await sleep(delay)
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new Error(`Embeddings failed: ${String(lastErr)}`)
}

/** Embeds a single string. Truncates oversized input to the model limit. */
export async function embedText(text: string): Promise<number[]> {
  const trimmed = text.trim()
  if (!trimmed) {
    throw new Error("Cannot embed empty text")
  }
  const [vector] = await callEmbeddings(truncate(trimmed))
  return vector
}

/** Batch-embed several strings in a single API call. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const cleaned = texts.map((t) => truncate(t.trim())).filter((t) => t.length > 0)
  if (cleaned.length === 0) {
    return []
  }
  return callEmbeddings(cleaned)
}

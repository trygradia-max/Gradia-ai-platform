import { z } from "zod"

// An exact HTTPS origin is a browser allowlist, not proof of a human's identity.
export const publicFormOriginSchema = z.string().max(253).refine((value) => {
  try {
    const url = new URL(value)
    return url.protocol === "https:" && url.origin === value &&
      /^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$/.test(value)
  } catch { return false }
})

const text = z.string().trim().min(1).max(200)
export const publicFormSubmissionSchema = z.object({
  submission_id: z.string().uuid(),
  display_name: text.optional(),
  phone: z.string().trim().min(5).max(40).optional(),
  email: z.string().trim().email().max(200).optional(),
  message: z.string().trim().min(1).max(4000).optional(),
  vehicle_text: text.optional(),
  service_text: text.optional(),
}).strict().refine(value => Boolean(value.phone || value.email))

export const publicFormConfigurationSchema = z.object({
  shopId: z.string().uuid(),
  formId: z.string().uuid(),
  origin: publicFormOriginSchema,
  enabled: z.boolean(),
  revision: z.number().int().nonnegative().max(2147483646),
}).strict()

export const publicFormResultSchema = z.object({
  id: z.string().uuid(), shop_id: z.string().uuid(), allowed_origin: publicFormOriginSchema,
  enabled: z.boolean(), revision: z.number().int().positive(),
}).strict()

export class FormBodyTooLarge extends Error {}
export class FormBodyTimeout extends Error {}
export const PUBLIC_FORM_BODY_TIMEOUT_MS = 10_000

/** Enforce the byte limit even when Content-Length is absent or forged. */
export async function readPublicFormBody(request: Request): Promise<unknown> {
  const limit = 16384
  const declared = request.headers.get("content-length")
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new FormBodyTooLarge()
  if (!request.body) throw new Error("Body required")
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let rejectDeadline: (error: Error) => void = () => {}
  const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject })
  const cancel = () => { void reader.cancel().catch(() => {}) }
  const expire = () => { rejectDeadline(new FormBodyTimeout()); cancel() }
  const timer = setTimeout(expire, PUBLIC_FORM_BODY_TIMEOUT_MS)
  request.signal.addEventListener("abort", expire, { once: true })
  if (request.signal.aborted) expire()
  try {
    for (;;) {
      const { done, value } = await Promise.race([deadline, reader.read()])
      if (done) break
      size += value.byteLength
      if (size > limit) { cancel(); throw new FormBodyTooLarge() }
      chunks.push(value)
    }
  } finally {
    clearTimeout(timer)
    request.signal.removeEventListener("abort", expire)
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
}

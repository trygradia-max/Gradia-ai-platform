import { z } from "zod"
import { publicFormOriginSchema, publicFormSubmissionSchema } from "@/lib/public-form-intake"

export type PublicFormAttempt =
  | { state: "accepted" }
  | { state: "rejected"; status: number }
  | { state: "retryable"; status: number }
  | { state: "uncertain" }

export const PUBLIC_FORM_REQUEST_TIMEOUT_MS = 20_000

/** One immutable inquiry, kept by the form UI until its outcome is known.
 * Reuse submit() on a manual retry. Never create a new handle per button click.
 * No automatic retries, persistence, cookies, tenant selection or consent claims.
 */
export function preparePublicFormSubmission(input: {
  appOrigin: string
  formId: string
  fields: unknown
}) {
  const origin = publicFormOriginSchema.parse(input.appOrigin)
  const formId = z.string().uuid().parse(input.formId)
  // Reject caller-supplied ids/authority before adding our stable command id.
  if (!input.fields || typeof input.fields !== "object" || Array.isArray(input.fields) || "submission_id" in input.fields) {
    throw new Error("Invalid inquiry fields")
  }
  const submissionId = crypto.randomUUID()
  const payload = publicFormSubmissionSchema.parse({ ...input.fields, submission_id: submissionId })
  const body = JSON.stringify(payload)
  const endpoint = `${origin}/api/intake/public-form/${formId}`
  let inFlight: Promise<PublicFormAttempt> | undefined
  let accepted = false

  async function attempt(): Promise<PublicFormAttempt> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<PublicFormAttempt>((resolve) => {
      timer = setTimeout(() => {
        resolve({ state: "uncertain" })
        controller.abort()
      }, PUBLIC_FORM_REQUEST_TIMEOUT_MS)
    })
    const send = async (): Promise<PublicFormAttempt> => {
      const response = await fetch(endpoint, {
        method: "POST", mode: "cors", credentials: "omit", redirect: "error",
        cache: "no-store", headers: { "Content-Type": "application/json" }, body,
        signal: controller.signal,
      })
      if (response.status === 202) {
        const result = await response.json()
        return result?.accepted === true ? { state: "accepted" } : { state: "uncertain" }
      }
      if ([400, 403, 409, 413, 415].includes(response.status)) {
        return { state: "rejected", status: response.status }
      }
      if ([408, 429].includes(response.status)) return { state: "retryable", status: response.status }
      return { state: "uncertain" }
    }
    try {
      const result = await Promise.race([send().catch((): PublicFormAttempt => ({ state: "uncertain" })), deadline])
      if (result.state === "accepted") accepted = true
      return result
    } finally { clearTimeout(timer) }
  }

  return Object.freeze({
    submissionId,
    submit(): Promise<PublicFormAttempt> {
      if (accepted) return Promise.resolve({ state: "accepted" })
      if (!inFlight) inFlight = attempt().finally(() => { inFlight = undefined })
      return inFlight
    },
  })
}

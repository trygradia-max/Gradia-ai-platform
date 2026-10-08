import { z } from "zod"
import { FormBodyTooLarge, publicFormOriginSchema, publicFormSubmissionSchema, readPublicFormBody } from "@/lib/public-form-intake"
import { createServiceClient } from "@/lib/supabase/service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
type Context = { params: Promise<{ formId: string }> }

function response(status: number, origin?: string): Response {
  const headers: Record<string, string> = { "Cache-Control": "no-store", Vary: "Origin" }
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin
    headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
    headers["Access-Control-Allow-Headers"] = "Content-Type"
  }
  if (status === 429) headers["Retry-After"] = "60"
  if (status === 204) return new Response(null, { status, headers })
  return Response.json(status === 202 ? { accepted: true } : {
    accepted: false,
    error: status === 429 ? "Submission limit reached. Try again later." :
      status === 409 ? "Submission changed. Use a new submission id." :
      status === 503 ? "Submission could not be confirmed. Retry the same submission id and content." :
      "Submission not accepted.",
  }, { status, headers })
}

async function binding(request: Request, context: Context) {
  const { formId } = await context.params
  const origin = request.headers.get("origin")
  if (!z.string().uuid().safeParse(formId).success || !publicFormOriginSchema.safeParse(origin).success) return null
  const db = createServiceClient()
  const result = await db.rpc("public_intake_form_origin", { p_form: formId, p_origin: origin })
  if (result.error) throw new Error("Binding lookup unavailable")
  return result.data === true ? { db, formId, origin: origin as string } : null
}

export async function OPTIONS(request: Request, context: Context) {
  try {
    const bound = await binding(request, context)
    if (!bound || request.headers.get("access-control-request-method") !== "POST") return response(403)
    const requested = (request.headers.get("access-control-request-headers") ?? "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean)
    if (requested.some(h => h !== "content-type")) return response(403)
    return response(204, bound.origin)
  } catch { return response(503) }
}

export async function POST(request: Request, context: Context) {
  let bound: Awaited<ReturnType<typeof binding>>
  try { bound = await binding(request, context) } catch { return response(503) }
  if (!bound) return response(403)
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return response(415, bound.origin)
  let body: unknown
  try { body = await readPublicFormBody(request) } catch (error) {
    return response(error instanceof FormBodyTooLarge ? 413 : 400, bound.origin)
  }
  const parsed = publicFormSubmissionSchema.safeParse(body)
  if (!parsed.success) return response(400, bound.origin)
  const { submission_id, ...payload } = parsed.data
  try {
    const result = await bound.db.rpc("submit_public_intake_form", {
      p_form: bound.formId, p_origin: bound.origin, p_submission: submission_id, p_payload: payload,
    })
    if (result.error) {
      const status = ({ "42501": 403, "22023": 400, PT409: 409, PT429: 429 } as Record<string, number>)[result.error.code] ?? 503
      return response(status, status === 403 ? undefined : bound.origin)
    }
    if (result.data?.accepted !== true) return response(503, bound.origin)
    return response(202, bound.origin)
  } catch { return response(503, bound.origin) }
}

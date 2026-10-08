import { randomUUID } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { publicFormOriginSchema, publicFormSubmissionSchema, readPublicFormBody, FormBodyTooLarge } from "@/lib/public-form-intake"
const rpc = vi.hoisted(() => vi.fn())
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({ rpc }) }))
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc }) }))
import { POST, OPTIONS } from "@/app/api/intake/public-form/[formId]/route"
import { configurePublicIntakeForm, listPublicIntakeForms } from "@/app/actions/public-intake-forms"
const formId = randomUUID(), origin = "https://shop.example.test"
const context = () => ({ params: Promise.resolve({ formId }) })
const payload = () => ({ submission_id: randomUUID(), email: "visitor@example.test", message: "Ceramic coating inquiry" })
const request = (body: unknown = payload(), headers: Record<string, string> = {}) => new Request(`https://app.example.test/api/intake/public-form/${formId}`, { method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify(body) })
beforeEach(() => { rpc.mockReset(); rpc.mockImplementation(async (name: string) => ({ data: name === "public_intake_form_origin" ? true : { accepted: true }, error: null })) })
describe("public website form boundary", () => {
  it("accepts only canonical HTTPS origins, without paths, credentials or wildcard", () => {
    expect(publicFormOriginSchema.safeParse(origin).success).toBe(true)
    for (const value of ["null", "http://shop.test", "https://shop.test/", "https://user@shop.test", "https://*.shop.test", "https://shop.test/path", "https://SHOP.test", "https://shop.test:99999"]) expect(publicFormOriginSchema.safeParse(value).success).toBe(false)
  })
  it("rejects caller-chosen tenancy, thread, consent and missing contacts", () => {
    for (const extra of [{ shop_id: randomUUID() }, { thread_key: "same-person" }, { consent: true }, { form_id: formId }, { shop_id: "" }]) expect(publicFormSubmissionSchema.safeParse({ ...payload(), ...extra }).success).toBe(false)
    expect(publicFormSubmissionSchema.safeParse({ submission_id: randomUUID(), message: "no contact" }).success).toBe(false)
  })
  it("bounds streamed bytes independently of Content-Length", async () => {
    for (const headers of [{}, { "content-length": "1" }] as Record<string, string>[]) await expect(readPublicFormBody(request({ message: "x".repeat(17000) }, headers))).rejects.toBeInstanceOf(FormBodyTooLarge)
    await expect(readPublicFormBody(request(payload(), { "content-length": "17000" }))).rejects.toBeInstanceOf(FormBodyTooLarge)
  })
  it("accepts without returning internal identifiers or customer existence", async () => {
    const body = payload(), response = await POST(request(body), context())
    expect(response.status).toBe(202); expect(await response.json()).toEqual({ accepted: true })
    expect(response.headers.get("access-control-allow-origin")).toBe(origin)
    expect(response.headers.get("access-control-allow-credentials")).toBeNull()
    expect(rpc).toHaveBeenLastCalledWith("submit_public_intake_form", { p_form: formId, p_origin: origin, p_submission: body.submission_id, p_payload: { email: body.email, message: body.message } })
  })
  it("denies missing binding and origin without submission effects", async () => {
    expect((await POST(request(payload(), { origin: "null" }), context())).status).toBe(403); expect(rpc).not.toHaveBeenCalled()
    rpc.mockResolvedValue({ data: false, error: null })
    const response = await POST(request(), context()); expect(response.status).toBe(403); expect(response.headers.get("access-control-allow-origin")).toBeNull(); expect(rpc).toHaveBeenCalledTimes(1)
  })
  it("allows only configured POST preflight without enabling credentials", async () => {
    const req = (method: string, headers = "content-type") => new Request("https://app.test", { method: "OPTIONS", headers: { origin, "access-control-request-method": method, "access-control-request-headers": headers } })
    expect((await OPTIONS(req("POST"), context())).status).toBe(204)
    expect((await OPTIONS(req("GET"), context())).status).toBe(403)
    expect((await OPTIONS(req("POST", "authorization"), context())).status).toBe(403)
    expect(rpc.mock.calls.every(c => c[0] === "public_intake_form_origin")).toBe(true)
  })
  it("rejects content type, oversize, malformed and untrusted fields before recording", async () => {
    expect((await POST(request(payload(), { "content-type": "text/plain" }), context())).status).toBe(415)
    expect((await POST(request({ ...payload(), message: "x".repeat(17000) }), context())).status).toBe(413)
    expect((await POST(request({ ...payload(), shop_id: randomUUID() }), context())).status).toBe(400)
    expect((await POST(new Request("https://app.test", { method: "POST", headers: { origin, "content-type": "application/json" }, body: "{" }), context())).status).toBe(400)
    expect(rpc.mock.calls.every(c => c[0] === "public_intake_form_origin")).toBe(true)
  })
  it.each([["PT429", 429], ["PT409", 409], ["42501", 403], ["22023", 400], ["XX000", 503]])("returns safe errors for %s without leaking provider/database text", async (code, status) => {
    rpc.mockImplementation(async (name: string) => name === "public_intake_form_origin" ? { data: true, error: null } : { data: null, error: { code, message: "private database detail" } })
    const response = await POST(request(), context()); expect(response.status).toBe(status); expect(await response.text()).not.toContain("private database")
    if (status === 429) expect(response.headers.get("retry-after")).toBe("60")
  })
  it("keeps transport uncertainty retry-safe and does not retry internally", async () => {
    rpc.mockImplementation(async (name: string) => { if (name === "public_intake_form_origin") return { data: true }; throw new Error("private") })
    const response = await POST(request(), context()); expect(response.status).toBe(503); expect(await response.text()).toContain("same submission id"); expect(rpc).toHaveBeenCalledTimes(2)
  })
  it("validates owner configuration results and refuses foreign list rows", async () => {
    const shopId = randomUUID(), input = { shopId, formId, origin, enabled: false, revision: 0 }
    rpc.mockResolvedValue({ data: { id: formId, shop_id: shopId, allowed_origin: origin, enabled: false, revision: 1 }, error: null })
    expect((await configurePublicIntakeForm(input)).ok).toBe(true)
    expect((await configurePublicIntakeForm({ ...input, shopId: randomUUID() })).ok).toBe(false)
    rpc.mockResolvedValue({ data: [{ id: formId, shop_id: randomUUID(), allowed_origin: origin, enabled: false, revision: 1 }], error: null })
    expect((await listPublicIntakeForms(shopId)).ok).toBe(false)
  })
})

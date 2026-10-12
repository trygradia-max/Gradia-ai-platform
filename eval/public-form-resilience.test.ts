import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FormBodyTimeout, FormBodyTooLarge, PUBLIC_FORM_BODY_TIMEOUT_MS, readPublicFormBody } from "@/lib/public-form-intake"
import { PUBLIC_FORM_REQUEST_TIMEOUT_MS, preparePublicFormSubmission } from "@/lib/public-form-client"

function streamed(stream: ReadableStream, signal?: AbortSignal) {
  return new Request("https://app.example.test", { method: "POST", body: stream, signal, duplex: "half" } as RequestInit)
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
describe("bounded public form reads", () => {
  it("ends a stalled upload and cancels without waiting on an uncooperative source", async () => {
    vi.useFakeTimers()
    const cancel = vi.fn(() => new Promise<void>(() => {}))
    const result = readPublicFormBody(streamed(new ReadableStream({ cancel })))
    const check = expect(result).rejects.toBeInstanceOf(FormBodyTimeout)
    await vi.advanceTimersByTimeAsync(PUBLIC_FORM_BODY_TIMEOUT_MS)
    await check
    expect(cancel).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it("uses one total deadline even when chunks keep arriving", async () => {
    vi.useFakeTimers()
    let controller!: ReadableStreamDefaultController
    const result = readPublicFormBody(streamed(new ReadableStream({ start(c) { controller = c } })))
    const check = expect(result).rejects.toBeInstanceOf(FormBodyTimeout)
    for (let i = 0; i < 4; i++) {
      controller.enqueue(new TextEncoder().encode(" "))
      await vi.advanceTimersByTimeAsync(2000)
    }
    await vi.advanceTimersByTimeAsync(2000)
    await check
  })
  it("stops on caller abort and cleans up the deadline", async () => {
    vi.useFakeTimers()
    const abort = new AbortController()
    const result = readPublicFormBody(streamed(new ReadableStream(), abort.signal))
    const check = expect(result).rejects.toBeInstanceOf(FormBodyTimeout)
    abort.abort(); await check
    expect(vi.getTimerCount()).toBe(0)
  })
  it("refuses a request that was already aborted", async () => {
    const abort = new AbortController(); abort.abort()
    await expect(readPublicFormBody(streamed(new ReadableStream(), abort.signal))).rejects.toBeInstanceOf(FormBodyTimeout)
  })
  it("does not wait for cancellation on an oversized body", async () => {
    const result = readPublicFormBody(streamed(new ReadableStream({
      start(c) { c.enqueue(new Uint8Array(16385)) }, cancel() { return new Promise<void>(() => {}) },
    })))
    await expect(result).rejects.toBeInstanceOf(FormBodyTooLarge)
  })
  it("cleans up after a valid body", async () => {
    vi.useFakeTimers()
    expect(await readPublicFormBody(new Request("https://app.test", { method: "POST", body: '{"ok":true}' }))).toEqual({ ok: true })
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe("one immutable browser inquiry", () => {
  const input = () => ({ appOrigin: "https://app.example.test", formId: randomUUID(), fields: { email: "visitor@example.test", message: "Please quote a detail" } })
  it("reuses the exact id and bytes after an unknown outcome, and never retries automatically", async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("connection lost")).mockResolvedValueOnce(Response.json({ accepted: true }, { status: 202 }))
    vi.stubGlobal("fetch", fetcher)
    const config = input(), handle = preparePublicFormSubmission(config)
    expect(await handle.submit()).toEqual({ state: "uncertain" })
    expect(fetcher).toHaveBeenCalledTimes(1)
    config.fields.message = "Edited after submitting"
    expect(await handle.submit()).toEqual({ state: "accepted" })
    expect(fetcher.mock.calls[0][1].body).toBe(fetcher.mock.calls[1][1].body)
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ submission_id: handle.submissionId, message: "Please quote a detail" })
    expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: "omit", redirect: "error", mode: "cors" })
    expect(await handle.submit()).toEqual({ state: "accepted" })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it("shares concurrent attempts rather than sending twice", async () => {
    let finish!: (r: Response) => void
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve }))
    vi.stubGlobal("fetch", fetcher)
    const handle = preparePublicFormSubmission(input()), a = handle.submit(), b = handle.submit()
    expect(a).toBe(b); expect(fetcher).toHaveBeenCalledOnce()
    finish(Response.json({ accepted: true }, { status: 202 }))
    expect(await a).toEqual({ state: "accepted" })
  })
  it.each([400, 403, 409, 413, 415, 408, 429, 500, 503])("classifies %s without leaking response details", async status => {
    const fetcher = vi.fn().mockResolvedValue(new Response("private details", { status }))
    vi.stubGlobal("fetch", fetcher)
    const result = await preparePublicFormSubmission(input()).submit()
    expect(result).toEqual(status >= 500 ? { state: "uncertain" } : { state: [408, 429].includes(status) ? "retryable" : "rejected", status })
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it("keeps malformed success and stalled response bodies uncertain", async () => {
    vi.useFakeTimers()
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("bad JSON", { status: 202 })).mockResolvedValueOnce(new Response(new ReadableStream(), { status: 202 })))
    const handle = preparePublicFormSubmission(input())
    expect(await handle.submit()).toEqual({ state: "uncertain" })
    const pending = handle.submit()
    await vi.advanceTimersByTimeAsync(PUBLIC_FORM_REQUEST_TIMEOUT_MS)
    expect(await pending).toEqual({ state: "uncertain" })
    expect(vi.getTimerCount()).toBe(0)
  })
  it("validates configuration and rejects supplied ids, tenancy and consent before network work", () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher)
    for (const patch of [{ submission_id: randomUUID() }, { shop_id: randomUUID() }, { consent: true }]) {
      const c = input(); expect(() => preparePublicFormSubmission({ ...c, fields: { ...c.fields, ...patch } })).toThrow()
    }
    expect(() => preparePublicFormSubmission({ ...input(), appOrigin: "http://app.test" })).toThrow()
    expect(() => preparePublicFormSubmission({ ...input(), formId: "bad" })).toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })
})

import { vi } from "vitest"
import { Socket } from "node:net"

export function allowedTestUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return process.env.INTEGRATION === "1" &&
      process.env.GRADIA_DISPOSABLE_TEST === "gradia-p0-tenant-policy-safety" &&
      url.origin === "http://127.0.0.1:55431" &&
      !url.username && !url.password
  } catch { return false }
}

const connect = Socket.prototype.connect

export function installNetworkGuard() {
  // A permanent socket boundary survives suites calling vi.restoreAllMocks().
  Object.defineProperty(Socket.prototype, "connect", { configurable: true, writable: true, value: function (this: Socket, ...args: unknown[]) {
    const first: unknown = args[0]
    const options = (Array.isArray(first) ? first[0] : first) as { host?: string; port?: number; path?: string }
    if (!options || typeof options !== "object" || !allowedTestUrl(`http://${options.host}:${options.port}`)) {
      throw new Error("Unexpected socket connection blocked by test harness")
    }
    return Reflect.apply(connect, this, args) as Socket
  } })
  const realFetch = globalThis.fetch
  vi.stubGlobal("fetch", ((input: RequestInfo | URL, init?: RequestInit) => {
    const raw = input instanceof Request ? input.url : String(input)
    if (!allowedTestUrl(raw)) throw new Error("Unexpected network request blocked by test harness")
    return realFetch(input, init)
  }) as typeof fetch)
}

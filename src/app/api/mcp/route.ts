/**
 * Gradia Internal MCP HTTP entry point. Implements the MCP
 * Streamable HTTP transport in stateless mode (one request, one
 * response) on top of Web Standard fetch — perfect for Vercel
 * serverless. Auth is per-shop bearer tokens minted via the
 * /settings UI; see lib/mcp/auth.ts.
 *
 * Per docs/mcp-architecture.md, this is the "Gradia Internal MCP"
 * — the load-bearing piece for the agentic future.
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"

import { resolveMcpAuth } from "@/lib/mcp/auth"
import { buildMcpServer } from "@/lib/mcp/server"
import { createServiceClient } from "@/lib/supabase/service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

async function handle(request: Request): Promise<Response> {
  const result = await resolveMcpAuth(request.headers.get("authorization"))
  if (!result.ok) {
    if (result.status === 429) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32002,
            message: "Daily request cap reached for this token",
          },
          id: null,
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": String(result.resetInSeconds),
          },
        }
      )
    }
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Invalid or missing bearer token" },
        id: null,
      }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "WWW-Authenticate": 'Bearer realm="gradia-mcp"',
        },
      }
    )
  }

  const { auth } = result
  // Stateless: a fresh transport + server per request. We use the
  // service-role supabase client because the bearer token has
  // already established trust + scoped the shop_id; every tool
  // explicitly passes shop_id in queries so RLS is unnecessary.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  const server = buildMcpServer({
    shopId: auth.shopId,
    shopName: auth.shopName,
    ownerId: auth.ownerId,
    supabase: createServiceClient(),
  })

  // Connect must happen before handleRequest dispatches.
  await server.connect(transport)
  return transport.handleRequest(request)
}

export async function POST(request: Request) {
  return handle(request)
}

export async function GET(request: Request) {
  return handle(request)
}

export async function DELETE(request: Request) {
  return handle(request)
}

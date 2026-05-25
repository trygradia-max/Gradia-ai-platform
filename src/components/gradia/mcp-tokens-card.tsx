"use client"

import * as React from "react"
import { Copy, Key, Loader2, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { mintMcpToken, revokeMcpToken } from "@/app/actions/mcp"
import { Button } from "@/components/ui/button"
import { useConfirm } from "@/components/ui/confirm-dialog"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { McpTokenRow } from "@/lib/types/database"

export function McpTokensCard({
  initialTokens,
}: {
  initialTokens: McpTokenRow[]
}) {
  const { confirm, dialog: confirmDialog } = useConfirm()
  const [tokens, setTokens] = React.useState(initialTokens)
  const [name, setName] = React.useState("")
  const [pending, setPending] = React.useState<null | "mint" | string>(null)
  const [justMinted, setJustMinted] = React.useState<{
    id: string
    plaintext: string
  } | null>(null)

  async function handleMint(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setPending("mint")
    const result = await mintMcpToken({ name })
    setPending(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setJustMinted({ id: result.id, plaintext: result.plaintext })
    setTokens([
      {
        id: result.id,
        shop_id: tokens[0]?.shop_id ?? "",
        name: name.trim(),
        token_hash: "(stored)",
        created_at: new Date().toISOString(),
        last_used_at: null,
        revoked_at: null,
        requests_today: 0,
        usage_date: new Date().toISOString().slice(0, 10),
      },
      ...tokens,
    ])
    setName("")
  }

  async function handleRevoke(id: string) {
    const ok = await confirm({
      title: "Revoke this token?",
      description:
        "Any agent using it will immediately get 401. The token can't be un-revoked — mint a new one if you need to.",
      confirmLabel: "Revoke",
      tone: "destructive",
    })
    if (!ok) return
    setPending(id)
    const result = await revokeMcpToken(id)
    setPending(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setTokens(
      tokens.map((t) =>
        t.id === id ? { ...t, revoked_at: new Date().toISOString() } : t
      )
    )
    toast.success("Revoked.")
  }

  async function copyPlaintext() {
    if (!justMinted) return
    try {
      await navigator.clipboard.writeText(justMinted.plaintext)
      toast.success("Copied to clipboard.")
    } catch {
      toast.error("Couldn't copy — long-press the value and copy manually.")
    }
  }

  return (
    <Card id="mcp" className="scroll-mt-20 border-border/80">
      {confirmDialog}
      <CardHeader className="flex flex-row items-center gap-3 space-y-0">
        <div className="flex size-10 items-center justify-center rounded-lg bg-muted/60">
          <Key className="size-5 text-primary" aria-hidden />
        </div>
        <div className="flex-1">
          <CardTitle className="text-base font-medium">
            Internal MCP tokens
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Bearer tokens for the Gradia Internal MCP — point Claude
            Desktop, a custom agent, or our own Builder/Co-owner
            persona at <code>/api/mcp</code> with this header. Each
            token is scoped to this shop. We store SHA-256 only;
            you&apos;ll only see the plaintext once.
          </p>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {justMinted ? (
          <div className="space-y-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium uppercase tracking-widest text-emerald-700 dark:text-emerald-400">
                New token — copy now, you can&apos;t see it again
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={copyPlaintext}
                className="gap-1.5"
              >
                <Copy className="size-3.5" aria-hidden />
                Copy
              </Button>
            </div>
            <code className="block break-all rounded-md bg-background px-3 py-2 font-mono text-xs">
              {justMinted.plaintext}
            </code>
            <button
              type="button"
              onClick={() => setJustMinted(null)}
              className="text-[11px] text-muted-foreground hover:text-foreground hover:underline"
            >
              I&apos;ve saved it — dismiss
            </button>
          </div>
        ) : null}

        <form className="grid gap-3" onSubmit={handleMint}>
          <div className="grid gap-2">
            <Label htmlFor="mcp-name">Token name</Label>
            <Input
              id="mcp-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Claude Desktop · home"
              autoComplete="off"
              maxLength={80}
              disabled={pending === "mint"}
            />
          </div>
          <div className="flex justify-end">
            <Button
              type="submit"
              disabled={pending === "mint" || !name.trim()}
              className="h-11 gap-2 sm:h-9"
            >
              {pending === "mint" ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Plus className="size-4" aria-hidden />
              )}
              Mint token
            </Button>
          </div>
        </form>

        {tokens.length > 0 ? (
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
              {tokens.filter((t) => !t.revoked_at).length} active
              {tokens.some((t) => t.revoked_at)
                ? ` · ${tokens.filter((t) => t.revoked_at).length} revoked`
                : null}
            </p>
            <ul className="grid gap-2">
              {tokens.map((token) => {
                const revoked = Boolean(token.revoked_at)
                return (
                  <li
                    key={token.id}
                    className="flex items-start gap-3 rounded-md border border-border/60 bg-muted/15 px-3 py-2.5"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">
                        {token.name}
                        {revoked ? (
                          <span className="ml-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                            revoked
                          </span>
                        ) : null}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Created {new Date(token.created_at).toLocaleDateString()}
                        {token.last_used_at
                          ? ` · last used ${new Date(token.last_used_at).toLocaleDateString()}`
                          : " · never used"}
                      </p>
                    </div>
                    {!revoked ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRevoke(token.id)}
                        disabled={pending === token.id}
                        className="text-muted-foreground hover:text-destructive"
                        aria-label={`Revoke ${token.name}`}
                      >
                        {pending === token.id ? (
                          <Loader2
                            className="size-3.5 animate-spin"
                            aria-hidden
                          />
                        ) : (
                          <Trash2 className="size-3.5" aria-hidden />
                        )}
                      </Button>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

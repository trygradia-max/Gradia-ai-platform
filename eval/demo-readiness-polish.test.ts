import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8")

describe("demo-readiness presentation locks", () => {
  it("rethrows Next control-flow errors before treating usage as an optional read", () => {
    const source = read("src/components/gradia/usage-pill.tsx")
    expect(source).toContain('import { unstable_rethrow } from "next/navigation"')
    expect(source.indexOf("unstable_rethrow(err)")).toBeLessThan(
      source.indexOf('console.error("[usage-pill] usage state failed:", err)')
    )
  })

  it("keeps one settings anchor for reviewed memory", () => {
    const page = read("src/app/(dashboard)/settings/page.tsx")
    const card = read("src/components/gradia/knowledge-settings-card.tsx")
    expect(page).toContain('<section id="knowledge">')
    expect(card).toContain('<Card id="knowledge-card"')
    expect(card).not.toContain('<Card id="knowledge"')
  })

  it("renders a semantic, human-readable delegated approval time", () => {
    const page = read("src/app/team/approvals/page.tsx")
    expect(page).toContain('<time dateTime={item.created_at}>{formatQueuedAt(item.created_at)}</time>')
    expect(page).not.toContain("Queued {item.created_at}")
    expect(page).toContain('timeZone: "UTC"')
  })

  it("uses the full muted token for the chat eyebrow and progress indicator", () => {
    const chat = read("src/components/gradia/bi-chat.tsx")
    expect(chat).toContain('<p className="label-eyebrow text-muted-foreground">Chat</p>')
    expect(chat).not.toContain('<p className="label-eyebrow text-muted-foreground/70">Chat</p>')
  })
})

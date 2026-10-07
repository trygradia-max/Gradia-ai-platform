import Link from "next/link"

import { InboxList, InboxShopSelect } from "@/components/gradia/inbox-list"
import type { InboxIndex } from "@/lib/data/inbox-index"
import { cn } from "@/lib/utils"

export function InboxFrame({
  index,
  activeCustomerId,
  activeChannel,
  children,
}: {
  index: InboxIndex
  activeCustomerId?: string
  activeChannel?: string
  children: React.ReactNode
}) {
  if (!index.shop) {
    return (
      <div className="p-6 text-sm">
        Conversation workspace unavailable.{" "}
        <Link href="/team" className="underline underline-offset-2">
          Your workspaces
        </Link>
      </div>
    )
  }

  const shop = index.shop
  const open = Boolean(activeCustomerId)
  const listHref = (p: number) =>
    `/conversations?shop=${shop.id}${p > 1 ? `&page=${p}` : ""}`

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <aside
        className={cn(
          "min-h-0 w-full flex-col border-border/70 bg-card/20 lg:flex lg:w-[340px] lg:shrink-0 lg:border-r",
          open ? "hidden lg:flex" : "flex"
        )}
      >
        <div className="border-b border-border/70 px-4 pb-3 pt-4">
          <h1 className="font-display text-xl tracking-tight">Inbox</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Texts, email, and calls. Opening a thread does not send or mark it
            read.
          </p>
          <InboxShopSelect shops={index.shops} shopId={shop.id} />
          {index.data ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {index.data.notifications} in-app handoff
              {index.data.notifications === 1 ? "" : "s"}. Manager email
              alerts are off.
            </p>
          ) : null}
        </div>
        {index.data && index.data.unidentified > 0 ? (
          <p
            role="alert"
            className="border-b border-border/70 bg-status-warning-bg px-4 py-2 text-xs text-status-warning-fg"
          >
            {index.data.unidentified} unidentified interaction
            {index.data.unidentified === 1 ? "" : "s"} still need a person
            attached. They are not combined into one thread.{" "}
            <Link
              href={`/intake?shop=${shop.id}`}
              className="font-medium underline underline-offset-2"
            >
              Open intake
            </Link>
          </p>
        ) : null}
        {index.loadFailed ? (
          <p role="alert" className="p-4 text-sm">
            Conversations could not be loaded. This is not an empty inbox.
          </p>
        ) : (
          <InboxList
            items={(index.data?.items ?? []).slice(0, 20)}
            shopId={shop.id}
            page={index.page}
            activeCustomerId={activeCustomerId}
            activeChannel={activeChannel}
          />
        )}
        {index.data ? (
          <nav
            className="flex gap-4 border-t border-border/70 px-4 py-3 text-sm"
            aria-label="Conversation pages"
          >
            {index.page > 1 ? (
              <Link href={listHref(index.page - 1)} className="underline underline-offset-2">
                Previous
              </Link>
            ) : null}
            {index.data.items.length > 20 ? (
              <Link href={listHref(index.page + 1)} className="underline underline-offset-2">
                Next
              </Link>
            ) : null}
          </nav>
        ) : null}
      </aside>
      <section
        className={cn(
          "min-h-0 min-w-0 flex-1 flex-col",
          open ? "flex" : "hidden lg:flex"
        )}
      >
        {children}
      </section>
    </div>
  )
}

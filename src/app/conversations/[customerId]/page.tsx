import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import { requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import { channelSchema, threadSchema } from "@/lib/whisper-inbox"
import { WhisperInboxControls } from "@/components/gradia/whisper-inbox-controls"
import { InboxFrame } from "@/components/gradia/inbox-frame"
import {
  WhisperThreadView,
  WhisperWorkspaceUnavailable,
} from "@/components/gradia/whisper-inbox-presentation"
import { loadInboxIndex } from "../load-inbox"

export const dynamic = "force-dynamic"
export const metadata = { title: "Conversation" }

export default async function ThreadPage({
  params,
  searchParams,
}: {
  params: Promise<{
    customerId: string
  }>
  searchParams: Promise<{
    shop?: string
    channel?: string
    page?: string
    list?: string
  }>
}) {
  await requireUser()
  const { customerId } = await params,
    q = await searchParams,
    n = Number(q.page ?? 1),
    page = Number.isSafeInteger(n) && n > 0 && n < 100000 ? n : 1
  const index = await loadInboxIndex(q.shop, q.list)
  if (!index.shop) return <WhisperWorkspaceUnavailable />
  const valid =
    z.string().uuid().safeParse(customerId).success &&
    z.string().uuid().safeParse(q.shop).success &&
    channelSchema.safeParse(q.channel).success
  const db = await createClient(),
    r = valid
      ? await db.rpc("read_whisper_thread", {
          p_shop: q.shop,
          p_customer: customerId,
          p_channel: q.channel,
          p_offset: (page - 1) * 20,
        })
      : null
  const parsed = r && !r.error ? threadSchema.safeParse(r.data) : null,
    t =
      parsed?.success &&
      parsed.data.customer_id === customerId &&
      parsed.data.channel === q.channel
        ? parsed.data
        : null
  const listQuery = index.page > 1 ? `&list=${index.page}` : ""
  const listHref = `/conversations?shop=${encodeURIComponent(index.shop.id)}${index.page > 1 ? `&page=${index.page}` : ""}`
  const refreshHref = `/conversations/${encodeURIComponent(customerId)}?shop=${encodeURIComponent(q.shop ?? "")}&channel=${encodeURIComponent(q.channel ?? "")}${listQuery}`
  const channel = channelSchema.safeParse(q.channel).success ? q.channel : undefined
  return (
    <InboxFrame
      shops={index.shops}
      shopId={index.shop.id}
      page={index.page}
      data={index.data}
      activeCustomerId={customerId}
      activeChannel={channel}
    >
      <WhisperThreadView
        listHref={listHref}
        refreshHref={refreshHref}
        page={page}
        thread={t}
        shopId={q.shop ?? ""}
        customerId={customerId}
        controls={
          t && page === 1 ? (
            <WhisperInboxControls
              key={createHash("sha256").update(JSON.stringify(t)).digest("hex")}
              shopId={q.shop!}
              thread={t}
              commands={{ read: randomUUID(), handoff: randomUUID(), reply: randomUUID() }}
            />
          ) : null
        }
      />
    </InboxFrame>
  )
}

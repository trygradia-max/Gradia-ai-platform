import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"

import { InboxFrame } from "@/components/gradia/inbox-frame"
import { InboxThread } from "@/components/gradia/inbox-thread"
import { WhisperInboxControls } from "@/components/gradia/whisper-inbox-controls"
import { loadInboxIndex } from "@/lib/data/inbox-index"
import { requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import { channelSchema, threadSchema } from "@/lib/whisper-inbox"

export const dynamic = "force-dynamic"

export default async function ThreadPage({
  params,
  searchParams,
}: {
  params: Promise<{ customerId: string }>
  searchParams: Promise<{ shop?: string; channel?: string; page?: string }>
}) {
  await requireUser()
  const { customerId } = await params
  const q = await searchParams
  const n = Number(q.page ?? 1)
  const page = Number.isSafeInteger(n) && n > 0 && n < 100000 ? n : 1
  const valid =
    z.string().uuid().safeParse(customerId).success &&
    z.string().uuid().safeParse(q.shop).success &&
    channelSchema.safeParse(q.channel).success
  const db = await createClient()
  const r = valid
    ? await db.rpc("read_whisper_thread", {
        p_shop: q.shop,
        p_customer: customerId,
        p_channel: q.channel,
        p_offset: (page - 1) * 20,
      })
    : null
  const parsed = r && !r.error ? threadSchema.safeParse(r.data) : null
  const t =
    parsed?.success &&
    parsed.data.customer_id === customerId &&
    parsed.data.channel === q.channel
      ? parsed.data
      : null
  const base = `/conversations/${encodeURIComponent(customerId)}?shop=${encodeURIComponent(q.shop ?? "")}&channel=${encodeURIComponent(q.channel ?? "")}`
  const index = await loadInboxIndex(q.shop, q.page)
  const channel = channelSchema.safeParse(q.channel).success ? q.channel : undefined

  return (
    <InboxFrame
      index={index}
      activeCustomerId={customerId}
      activeChannel={channel}
    >
      {!t || !q.shop ? (
        <p role="alert" className="p-6 text-sm">
          Conversation unavailable. Check access and refresh.
        </p>
      ) : (
        <InboxThread
          thread={t}
          shopId={q.shop}
          customerId={customerId}
          page={page}
          base={base}
          controls={
            page === 1 ? (
              <WhisperInboxControls
                key={createHash("sha256").update(JSON.stringify(t)).digest("hex")}
                shopId={q.shop}
                thread={t}
                commands={{
                  read: randomUUID(),
                  handoff: randomUUID(),
                  reply: randomUUID(),
                }}
              />
            ) : null
          }
        />
      )}
    </InboxFrame>
  )
}

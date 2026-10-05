import { createHash, randomUUID } from "node:crypto";
import Link from "next/link";
import { z } from "zod";
import { requireUser } from "@/lib/shop";
import { createClient } from "@/lib/supabase/server";
import { channelSchema, threadSchema, threadStateLabels } from "@/lib/whisper-inbox";
import { WhisperInboxControls } from "@/components/gradia/whisper-inbox-controls";
export const dynamic = "force-dynamic";
export default async function ThreadPage({ params, searchParams }: {
    params: Promise<{
        customerId: string;
    }>;
    searchParams: Promise<{
        shop?: string;
        channel?: string;
        page?: string;
    }>;
}) {
    await requireUser();
    const { customerId } = await params, q = await searchParams, n = Number(q.page ?? 1), page = Number.isSafeInteger(n) && n > 0 && n < 100000 ? n : 1;
    const valid = z.string().uuid().safeParse(customerId).success && z.string().uuid().safeParse(q.shop).success && channelSchema.safeParse(q.channel).success;
    const db = await createClient(), r = valid ? await db.rpc("read_whisper_thread", { p_shop: q.shop, p_customer: customerId, p_channel: q.channel, p_offset: (page - 1) * 20 }) : null;
    const parsed = r && !r.error ? threadSchema.safeParse(r.data) : null, t = parsed?.success && parsed.data.customer_id === customerId && parsed.data.channel === q.channel ? parsed.data : null;
    const base = `/conversations/${encodeURIComponent(customerId)}?shop=${encodeURIComponent(q.shop ?? "")}&channel=${encodeURIComponent(q.channel ?? "")}`;
    return <main className="mx-auto w-full max-w-3xl space-y-6 p-6"><Link className="underline" href={`/conversations?shop=${encodeURIComponent(q.shop ?? "")}`}>Back to conversations</Link><h1 className="text-2xl font-semibold">{t?.customer.name ?? "Conversation"}</h1>
 {!t ? <p role="alert">Conversation unavailable. Check access and refresh.</p> : <><p>{t.channel} · {threadStateLabels[t.state]}</p>{t.state === "held" ? <p role="alert">{t.reason || "Execution is unconfirmed. Review approval and provider evidence; never automatically resend."}</p> : null}
 {t.can_reply ? <Link className="underline" href={`/customers/${customerId}`}>Customer record</Link> : null}
 <ul>{t.intakes.map(i => <li key={i.id}><Link className="underline" href={`/intake/${i.id}?shop=${q.shop}`}>Intake evidence and reviewed vehicle</Link>{i.vehicle_id ? <span> · Vehicle reference {i.vehicle_id}</span> : null}</li>)}</ul>
 <ol className="space-y-3">{t.items.slice(0, 20).map(m => <li key={m.id} className="rounded border p-4"><p>{m.role} · {new Date(m.occurred_at).toLocaleString('en-US', { timeZone: 'UTC' })} UTC</p><p className="whitespace-pre-wrap break-words">{m.content}</p></li>)}</ol>
 <nav className="flex gap-4" aria-label="Message pages">{page > 1 ? <Link href={`${base}&page=${page - 1}`}>Newer messages</Link> : null}{t.items.length > 20 ? <Link href={`${base}&page=${page + 1}`}>Older messages</Link> : null}</nav>
 {t.actions.length ? <section><h2>Approval and execution records</h2><ul>{t.actions.map(a => <li key={a.id}><Link className="underline" href={`/approvals/${a.id}`}>{a.status}{a.status === "approved" && !a.result_id ? " — execution unconfirmed; review, do not resend" : ""}</Link></li>)}</ul></section> : null}
 {page === 1 ? <WhisperInboxControls key={createHash('sha256').update(JSON.stringify(t)).digest('hex')} shopId={q.shop!} thread={t} commands={{ read: randomUUID(), handoff: randomUUID(), reply: randomUUID() }}/> : null}</>}
 <Link className="underline" href={base}>Refresh conversation</Link></main>;
}

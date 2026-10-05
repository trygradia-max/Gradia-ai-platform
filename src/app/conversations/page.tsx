import Link from "next/link";
import { requireUser, getOptionalShop } from "@/lib/shop";
import { createClient } from "@/lib/supabase/server";
import { threadListSchema, threadStateLabels } from "@/lib/whisper-inbox";
import type { TeamWorkspace } from "@/lib/team-permissions";
import { BiChat } from "@/components/gradia/bi-chat";
import { FEATURES } from "@/lib/features";
import { getLatestConversationWithMessages, getConversationByIdWithMessages } from "@/lib/data/bi-conversations";
export const dynamic = "force-dynamic";
export default async function ConversationsPage({ searchParams }: {
    searchParams: Promise<{
        shop?: string;
        page?: string;
        c?: string;
    }>;
}) {
    await requireUser();
    const db = await createClient(), params = await searchParams;
    const workspaces = await db.rpc("team_workspaces");
    if (workspaces.error)
        throw new Error("Workspace access could not be verified.");
    const shops = (workspaces.data ?? []) as TeamWorkspace[], shop = params.shop ? shops.find(s => s.id === params.shop) : shops[0];
    if (!shop)
        return <main className="p-6">Conversation workspace unavailable. <Link href="/team">Your workspaces</Link></main>;
    const n = Number(params.page ?? 1), page = Number.isSafeInteger(n) && n > 0 && n < 100000 ? n : 1;
    const r = await db.rpc("list_whisper_threads", { p_shop: shop.id, p_offset: (page - 1) * 20 }), parsed = r.error ? null : threadListSchema.safeParse(r.data);
    const data = parsed?.success ? parsed.data : null;
    const active = await getOptionalShop();
    const loaded = FEATURES.askGradiaPage && active?.id === shop.id ? (params.c ? await getConversationByIdWithMessages(params.c) : await getLatestConversationWithMessages()) : null;
    return <main className="mx-auto w-full max-w-3xl space-y-6 p-6"><Link href="/team" className="underline">Your workspaces</Link><h1 className="text-2xl font-semibold">Whisper conversations</h1>
 <nav className="flex flex-wrap gap-3" aria-label="Conversation workspaces">{shops.map(s => <Link className="underline" key={s.id} href={`/conversations?shop=${s.id}`}>{s.name}</Link>)}</nav>
 <p>Stored SMS, email and call history. Opening a thread does not send, mark it read or grant consent.</p>
 {!data ? <p role="alert">Conversations could not be loaded. This is not an empty inbox.</p> : <><p>{data.notifications} in-app handoff notifications. Manager email notifications are disabled.</p>{data.unidentified > 0 ? <p role="alert">{data.unidentified} unidentified interactions need identity review. They have not been combined into one customer thread. <Link href={`/intake?shop=${shop.id}`} className="underline">Open intake</Link></p> : null}
 <ul className="space-y-3">{data.items.slice(0, 20).map(t => <li key={`${t.customer_id}:${t.channel}`} className="rounded border p-4"><Link className="underline" href={`/conversations/${t.customer_id}?shop=${shop.id}&channel=${t.channel}`}>{t.customer_name ?? "Unnamed customer"} · {t.channel}</Link><p className="break-words">{t.preview}</p><p>{t.notified ? "New handoff · " : ""}{t.unread ? "Unread · " : ""}{threadStateLabels[t.state]} · {t.assignee}</p></li>)}</ul>{!data.items.length ? <p>No visible conversations on this page.</p> : null}
 <nav className="flex gap-4" aria-label="Conversation pages">{page > 1 ? <Link href={`/conversations?shop=${shop.id}&page=${page - 1}`}>Previous</Link> : null}{data.items.length > 20 ? <Link href={`/conversations?shop=${shop.id}&page=${page + 1}`}>Next</Link> : null}</nav></>}
 {FEATURES.askGradiaPage && active?.id === shop.id ? <section><h2>Ask Gradia</h2><BiChat key={loaded?.conversation.id ?? "fresh"} initial={loaded ? { conversationId: loaded.conversation.id, messages: loaded.messages.map(m => ({ role: m.role, content: m.content })) } : { conversationId: null, messages: [] }}/></section> : null}
 </main>;
}

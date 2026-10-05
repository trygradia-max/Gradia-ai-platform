"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { updateWhisperInbox } from "@/app/actions/whisper-inbox";
import type { WhisperThread } from "@/lib/whisper-inbox";
export function WhisperInboxControls({ shopId, thread, commands }: {
    shopId: string;
    thread: WhisperThread;
    commands: {
        read: string;
        handoff: string;
        reply: string;
    };
}) {
    const [busy, start] = useTransition(), [message, setMessage] = useState(""), router = useRouter();
    const [assignee, setAssignee] = useState(thread.assignee_id ?? ""), [state, setState] = useState("needs_reply"), [reason, setReason] = useState("");
    const [body, setBody] = useState(""), [subject, setSubject] = useState("");
    function run(operation: "read" | "handoff" | "reply", payload: unknown) { start(async () => { try {
        const r = await updateWhisperInbox({ shopId, customerId: thread.customer_id, channel: thread.channel, latestId: thread.latest_id, revision: thread.revision, commandId: commands[operation], operation, payload });
        setMessage(r.message);
        if (r.ok) {
            toast.success(r.message);
            router.refresh();
        }
    }
    catch {
        setMessage("Result uncertain. Refresh before retrying.");
    } }); }
    return <section className="space-y-5" aria-label="Conversation controls">
 <button disabled={busy} onClick={() => run("read", {})} className="rounded border p-2">Mark read for me</button>
 {thread.can_manage ? <form className="space-y-3 rounded border p-4" onSubmit={e => { e.preventDefault(); run("handoff", { assignee_id: assignee || null, state, reason }); }}>
 <h2 className="font-semibold">Assignment and handoff</h2>
 <label className="block">Responsible operator<select className="block w-full bg-background border p-2" value={assignee} onChange={e => setAssignee(e.target.value)} disabled={busy}><option value="">Owner fallback</option>{thread.members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
 <label className="block">Work state<select className="block w-full bg-background border p-2" value={state} onChange={e => setState(e.target.value)} disabled={busy}><option value="needs_reply">Needs reply</option><option value="held">Held for review</option><option value="completed">Completed by operator</option></select></label>
 <label className="block">Handoff reason<textarea className="block w-full bg-background border p-2" value={reason} maxLength={1000} required={state === "held"} onChange={e => setReason(e.target.value)} disabled={busy}/></label>
 <p className="text-sm">Completion does not mean a message was delivered. Handoff flags do not pause or cancel queued actions; manage those in Approvals. Pending approvals and uncertain execution remain visible.</p>
 <button disabled={busy} className="rounded border p-2">Save handoff</button></form> : null}
 {thread.can_reply && thread.channel !== "voice" ? <form className="space-y-3 rounded border p-4" onSubmit={e => { e.preventDefault(); run("reply", { body, subject, destination: thread.channel === "sms" ? thread.customer.phone : thread.customer.email }); }}>
 <h2 className="font-semibold">Draft reply for approval</h2><p>Recipient: {thread.channel === "sms" ? thread.customer.phone : thread.customer.email}</p>
 {thread.channel === "email" ? <label className="block">Subject<input className="block w-full bg-background border p-2" required maxLength={200} value={subject} onChange={e => setSubject(e.target.value)} disabled={busy}/></label> : null}
 <label className="block">Reply<textarea className="block w-full bg-background border p-2" required maxLength={thread.channel === "sms" ? 1600 : 8000} value={body} onChange={e => setBody(e.target.value)} disabled={busy}/></label>
 <p className="text-sm">Queues through the existing approval and send checks. Marketing consent is required; this composer cannot assert a service-purpose exemption. Email is a new outbound draft, not yet a provider-threaded reply.</p>
 <button disabled={busy || !(thread.channel === "sms" ? thread.customer.phone : thread.customer.email)} className="rounded border p-2">Queue draft in Approvals</button></form> : null}
 {message ? <p role="status">{message}</p> : null}
 </section>;
}

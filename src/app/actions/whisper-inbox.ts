"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/shop";
import { createClient } from "@/lib/supabase/server";
import { whisperCommandSchema } from "@/lib/whisper-inbox";
export async function updateWhisperInbox(input: unknown): Promise<{
    ok: boolean;
    message: string;
}> {
    const p = whisperCommandSchema.safeParse(input);
    if (!p.success)
        return { ok: false, message: "Review the conversation and complete the required fields." };
    await requireUser();
    const db = await createClient(), c = p.data;
    try {
        const r = await db.rpc("whisper_command", { p_shop: c.shopId, p_customer: c.customerId, p_channel: c.channel, p_command: c.commandId, p_latest: c.latestId, p_revision: c.revision, p_operation: c.operation, p_payload: c.payload });
        if (r.error || r.data !== c.commandId)
            return { ok: false, message: "Not confirmed. Refresh and check current access, recipient, policy and conversation state." };
        revalidatePath("/conversations");
        revalidatePath(`/conversations/${c.customerId}`);
        revalidatePath("/approvals");
        return { ok: true, message: c.operation === "reply" ? "Draft queued in Approvals. Nothing was sent." : c.operation === "read" ? "Marked read for your account." : "Handoff recorded. In-app notification created; email delivery is disabled." };
    }
    catch {
        return { ok: false, message: "Result uncertain. Refresh and inspect history before retrying." };
    }
}

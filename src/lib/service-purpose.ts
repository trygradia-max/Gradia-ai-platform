import { normalizeDestination } from "@/lib/contact-destination";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
// Server-internal capability: signed over exact content and recipient. Never
// export an issuer through a Server Action or MCP tool. Approval edits invalidate it.
export type ServiceMessage = {
    shopId: string;
    customerId: string;
    channel: "sms" | "email";
    destination: string;
    body: string;
    subject?: string;
};
export type ServiceContext = {
    kind: "quote" | "appointment" | "payment" | "reply";
    id: string;
};
function key(): string | null {
    return process.env.SUPABASE_SERVICE_ROLE_KEY || null;
}
function encoded(message: ServiceMessage, context: ServiceContext, expires: number) { return JSON.stringify(["gradia.service-purpose.v1", message.shopId, message.customerId, message.channel, message.destination, message.body, message.subject ?? "", context, expires]); }
export async function issueServiceProof(db: SupabaseClient, message: ServiceMessage, context: ServiceContext): Promise<string | null> {
    const secret = key();
    if (!secret)
        return null;
    const table = { quote: "quotes", appointment: "appointments", payment: "payments", reply: "interactions" }[context.kind];
    const { data, error } = await db.from(table).select("*").eq("shop_id", message.shopId).eq("id", context.id).maybeSingle();
    if (error || !data || data.shop_id !== message.shopId || data.customer_id !== message.customerId)
        return null;
    if (context.kind === "reply") {
        const age = Date.now() - Date.parse(data.created_at);
        const address = message.channel === "sms" ? data.metadata?.from_phone : data.metadata?.from_email;
        if (data.channel !== message.channel || data.role !== "customer" || data.metadata?.direction !== "inbound" || address !== message.destination || !Number.isFinite(age) || age < 0 || age > 48 * 60 * 60 * 1000)
            return null;
    }
    const expires = Date.now() + 24 * 60 * 60 * 1000;
    const content = encoded(message, context, expires);
    return Buffer.from(JSON.stringify({ context, expires, signature: createHmac("sha256", secret).update(content).digest("hex") })).toString("base64url");
}
export async function verifyServiceProof(db: SupabaseClient, message: ServiceMessage, proof: unknown): Promise<boolean> {
    const secret = key();
    if (!secret || typeof proof !== "string")
        return false;
    try {
        const { context, expires, signature } = JSON.parse(Buffer.from(proof, "base64url").toString());
        if (!context || !["quote", "appointment", "payment", "reply"].includes(context.kind) || typeof context.id !== "string" || !Number.isFinite(expires) || expires < Date.now())
            return false;
        const expected = createHmac("sha256", secret).update(encoded(message, context, expires)).digest();
        const actual = Buffer.from(signature, "hex");
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
            return false;
        // Recheck the parent at send time; deletion/reassignment cannot retain authority.
        return await issueServiceProof(db, message, context) !== null;
    }
    catch {
        return false;
    }
}
/** Used only at deterministic service producers, never for arbitrary proposals. */
export async function servicePayload(db: SupabaseClient, shopId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
        const channel = payload.to_phone ? "sms" : "email";
        const destination = normalizeDestination(channel, String(payload.to_phone ?? payload.to_email ?? ""));
        if (!destination)
            return { ...payload, service_proof: null };
        let customerId = payload.customer_id as string | undefined;
        if (!customerId) {
            const { data, error } = await db.from("customers").select("id").eq("shop_id", shopId).eq(channel === "sms" ? "phone_canonical" : "email_canonical", destination).maybeSingle();
            if (!error)
                customerId = data?.id;
        }
        let context: ServiceContext | null = payload.quote_id ? { kind: "quote", id: String(payload.quote_id) } : payload.appointment_id ? { kind: "appointment", id: String(payload.appointment_id) } : payload.payment_id ? { kind: "payment", id: String(payload.payment_id) } : null;
        if (!context && payload.stripe_invoice_id && customerId) {
            const { data, error } = await db.from("payments").select("id").eq("shop_id", shopId).eq("customer_id", customerId).eq("stripe_invoice_id", payload.stripe_invoice_id).maybeSingle();
            if (!error && data)
                context = { kind: "payment", id: data.id };
        }
        if (!context && customerId && ["sms_auto_draft", "email_auto_draft", "verified_reply"].includes(String(payload.source))) {
            const { data, error } = await db.from("interactions").select("*").eq("shop_id", shopId).eq("customer_id", customerId).eq("channel", channel).eq("role", "customer").order("created_at", { ascending: false }).limit(1).maybeSingle();
            if (!error && data)
                context = { kind: "reply", id: data.id };
        }
        const service_proof = customerId && context ? await issueServiceProof(db, { shopId, customerId, channel, destination, body: String(payload.body ?? ""), subject: payload.subject as string | undefined }, context) : null;
        return { ...payload, [channel === "sms" ? "to_phone" : "to_email"]: destination, customer_id: customerId ?? null, service_proof };
    }
    catch {
        return { ...payload, service_proof: null };
    }
}

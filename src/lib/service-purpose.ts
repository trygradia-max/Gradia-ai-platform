import { normalizeDestination } from "@/lib/contact-destination";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

// Server internal only. Old unsigned/v1 authority fails closed and needs review.
export type ServiceMessage = {
    shopId: string; customerId: string; channel: "sms" | "email";
    destination: string; body: string; subject?: string; actionId?: string;
};
export type ServiceContext = { kind: "quote" | "appointment" | "payment" | "reply"; id: string };
type Proof = {
    version: 2; nonce: string; actionId: string | null; shopId: string;
    customerId: string; channel: "sms" | "email"; destination: string;
    contentHash: string; context: ServiceContext; purpose: string;
    expires: number; signature: string;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function key() { return process.env.SUPABASE_SERVICE_ROLE_KEY || null; }
// Only Unicode composition and line endings normalize; whitespace/content edits do not.
function contentHash(message: ServiceMessage) {
    const normalize = (s: string) => s.normalize("NFC").replace(/\r\n?/g, "\n");
    return createHash("sha256").update(JSON.stringify([normalize(message.body), normalize(message.subject ?? "")])).digest("hex");
}
function encoded(p: Omit<Proof, "signature">) {
    return JSON.stringify(["gradia.service-purpose.v2",p.nonce,p.actionId,p.shopId,p.customerId,p.channel,p.destination,p.contentHash,p.context.kind,p.context.id,p.purpose,p.expires]);
}
async function validContext(db: SupabaseClient, message: ServiceMessage, context: ServiceContext) {
    const table = {quote:"quotes",appointment:"appointments",payment:"payments",reply:"interactions"}[context.kind];
    const {data,error} = await db.from(table).select("*").eq("shop_id",message.shopId).eq("id",context.id).maybeSingle();
    if (error) throw new Error("Service context lookup failed");
    if (!data || data.shop_id !== message.shopId || data.customer_id !== message.customerId) return false;
    if (context.kind === "reply") {
        const age = Date.now() - Date.parse(data.created_at);
        const address = message.channel === "sms" ? data.metadata?.from_phone : data.metadata?.from_email;
        if (data.channel !== message.channel || data.role !== "customer" || data.metadata?.direction !== "inbound" || address !== message.destination || !Number.isFinite(age) || age < 0 || age > 48*60*60*1000) return false;
    }
    return true;
}
export async function issueServiceProof(db: SupabaseClient, message: ServiceMessage, context: ServiceContext): Promise<string | null> {
    const secret = key();
    if (!secret || (message.actionId && !uuid.test(message.actionId)) || !await validContext(db,message,context)) return null;
    const p: Omit<Proof,"signature"> = {version:2,nonce:randomUUID(),actionId:message.actionId ?? null,shopId:message.shopId,customerId:message.customerId,channel:message.channel,destination:message.destination,contentHash:contentHash(message),context,purpose:`service:${context.kind}`,expires:Date.now()+24*60*60*1000};
    return Buffer.from(JSON.stringify({...p,signature:createHmac("sha256",secret).update(encoded(p)).digest("hex")})).toString("base64url");
}
type ProofFailure = {code:"invalid_proof"|"expired_proof"|"context_mismatch"|"proof_lookup_failed"};
async function verifiedProof(db: SupabaseClient, message: ServiceMessage, proof: unknown): Promise<Proof | ProofFailure> {
    const secret = key();
    if (!secret || typeof proof !== "string") return {code:"invalid_proof"};
    let p: Proof;
    try {
        p = JSON.parse(Buffer.from(proof,"base64url").toString()) as Proof;
        if (p.version !== 2 || !uuid.test(p.nonce) || (p.actionId !== null && !uuid.test(p.actionId)) || !p.context || !["quote","appointment","payment","reply"].includes(p.context.kind) || typeof p.context.id !== "string" || !Number.isFinite(p.expires)) return {code:"invalid_proof"};
        const expected = createHmac("sha256",secret).update(encoded(p)).digest();
        const actual = Buffer.from(p.signature,"hex");
        if (actual.length !== expected.length || !timingSafeEqual(actual,expected)) return {code:"invalid_proof"};
    } catch { return {code:"invalid_proof"}; }
    if (p.expires <= Date.now()) return {code:"expired_proof"};
    if (p.shopId !== message.shopId || p.customerId !== message.customerId || p.channel !== message.channel || p.destination !== message.destination || p.contentHash !== contentHash(message) || p.purpose !== `service:${p.context.kind}` || (message.actionId && p.actionId && message.actionId !== p.actionId)) return {code:"context_mismatch"};
    try { if (!await validContext(db,message,p.context)) return {code:"context_mismatch"}; }
    catch { return {code:"proof_lookup_failed"}; }
    return p;
}
export async function verifyServiceProof(db: SupabaseClient, message: ServiceMessage, proof: unknown): Promise<boolean> {
    return !("code" in await verifiedProof(db,message,proof));
}
async function auditProofDenial(db: SupabaseClient, message: ServiceMessage, failure: ProofFailure) {
    // Never trust a forged token's nonce/shop for the audit identity. No token,
    // destination or content is logged. A DB outage still denies execution.
    try { await db.rpc("audit_service_proof_denial",{p_shop:message.shopId,p_action:message.actionId ?? randomUUID(),p_event:failure.code}); } catch { /* no send on audit failure */ }
}
export async function serviceProofDenial(db: SupabaseClient, message: ServiceMessage, proof: unknown): Promise<string | null> {
    const result = await verifiedProof(db,message,proof);
    if (!("code" in result)) return null;
    await auditProofDenial(db,message,result);
    const reasons = {invalid_proof:"Service purpose could not be verified. The proof is invalid; review this message.",expired_proof:"Service purpose proof expired. Review the message before retrying.",context_mismatch:"Service purpose context no longer matches the action, recipient or content. Review this message.",proof_lookup_failed:"Service purpose lookup failed. No message was sent."};
    return reasons[result.code];
}
export type ServiceExecution = {ok:true; nonce:string; actionId:string} | {ok:false; reason:string};
/** Must run after consent checks and before ANY provider operation, including token refresh.
 * A consumed proof is never released: uncertain delivery requires explicit reconciliation. */
export async function claimServiceExecution(db: SupabaseClient, message: ServiceMessage, proof: unknown, pending = true): Promise<ServiceExecution> {
    try {
        const p = await verifiedProof(db,message,proof);
        if ("code" in p) {
            await auditProofDenial(db,message,p);
            return {ok:false,reason:`Held for review — Service proof rejected (${p.code}). Review this message.`};
        }
        const actionId = message.actionId ?? p.actionId ?? p.nonce;
        const {signature: _signature, ...claims} = p;
        void _signature;
        const {data,error} = await db.rpc("claim_service_execution",{p_shop:message.shopId,p_action:actionId,p_pending:pending,p_claims:claims});
        if (error || data !== "claimed") return {ok:false,reason:"Held for review — Service proof was already used or could not be claimed. Review execution history before retrying."};
        return {ok:true,nonce:p.nonce,actionId};
    } catch { return {ok:false,reason:"Held for review — Service proof claim failed. No message was sent."}; }
}
export async function completeServiceExecution(db: SupabaseClient, shopId: string, claim: ServiceExecution | null): Promise<void> {
    if (!claim?.ok) return;
    // A failed completion write never releases the durable pre-send claim.
    try { await db.rpc("complete_service_execution",{p_shop:shopId,p_action:claim.actionId,p_nonce:claim.nonce}); } catch { /* retained claim prevents resend */ }
}
export async function auditServiceActionRetry(db: SupabaseClient, shopId: string, actionId: string): Promise<void> {
    try { await db.rpc("audit_service_action_retry",{p_shop:shopId,p_action:actionId}); } catch { /* already-decided action never executes */ }
}
/** Used only at deterministic service producers, never for arbitrary proposals. */
export async function servicePayload(db: SupabaseClient, shopId: string, payload: Record<string, unknown>, actionId?: string): Promise<Record<string, unknown>> {
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
        const service_proof = customerId && context ? await issueServiceProof(db, { shopId, customerId, channel, destination, body: String(payload.body ?? ""), subject: payload.subject as string | undefined, actionId }, context) : null;
        return { ...payload, [channel === "sms" ? "to_phone" : "to_email"]: destination, customer_id: customerId ?? null, service_proof };
    }
    catch {
        return { ...payload, service_proof: null };
    }
}

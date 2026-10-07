import { z } from "zod"
import { normalizeDestination } from "@/lib/contact-destination"
const phone=z.string().refine(v=>normalizeDestination("sms",v)===v,"Canonical international phone required")
const email=z.string().max(200).refine(v=>normalizeDestination("email",v)===v,"Canonical email required")
const name=z.string().trim().min(1).max(200)
const changes=z.object({name:name.optional(),phone:phone.optional(),email:email.optional()}).strict()
const vehicleChanges=z.object({make:z.string().trim().min(1).max(100).optional(),model:z.string().trim().min(1).max(100).optional(),year:z.number().int().min(1886).max(2100).optional(),color:z.string().trim().min(1).max(100).optional()}).strict().refine(v=>Object.keys(v).length>0)
export const recordSchemas = [
 z.object({type:z.literal("update_customer"),payload:z.object({
  customer_id:z.string().uuid(),before:z.object({name:z.string().nullable(),phone:z.string().nullable(),email:z.string().nullable()}).strict(),expected_updated_at:z.string().datetime({offset:true}),changes,
  vehicle:z.object({before:z.object({make:z.string().nullable(),model:z.string().nullable(),year:z.number().nullable(),color:z.string().nullable()}).strict().nullable(),id:z.string().uuid().nullable(),expected_updated_at:z.string().datetime({offset:true}).nullable(),changes:vehicleChanges}).strict().nullable(),
 }).strict().refine(v=>Object.keys(v.changes).length>0||v.vehicle!==null)}),
 z.object({type:z.literal("resolve_customer"),payload:z.object({name:name.nullable(),phone:phone.nullable(),email:email.nullable()}).strict().refine(v=>Boolean(v.phone||v.email))}),
 z.object({type:z.literal("record_interaction"),payload:z.object({customer_id:z.string().uuid().nullable(),channel:z.enum(["sms","email","voice","web","note"]),role:z.enum(["customer","gradia","system"]),content:z.string().trim().min(1).max(8000),metadata:z.record(z.string(),z.unknown())}).strict()}),
] as const
export const recordCommandSchema=z.discriminatedUnion("type",recordSchemas)
export type RecordCommand=z.infer<typeof recordCommandSchema>
export function isRecordAction(type:string):type is RecordCommand["type"] {
 return ["update_customer","resolve_customer","record_interaction"].includes(type)
}

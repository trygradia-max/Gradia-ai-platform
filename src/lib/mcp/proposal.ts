import { z } from "zod"
import { normalizeDestination } from "@/lib/contact-destination"
export const mcpProposalSchemas = [
  z.object({type:z.literal("send_sms"),payload:z.object({customer_id:z.string().uuid(),customer_name:z.string().max(200).nullable(),to_phone:z.string().refine(v=>normalizeDestination("sms",v)===v),body:z.string().trim().min(1).max(1600),category:z.literal("marketing"),reason:z.string().max(200).nullable()}).strict()}),
  z.object({type:z.literal("send_email"),payload:z.object({customer_id:z.string().uuid(),customer_name:z.string().max(200).nullable(),to_email:z.string().refine(v=>normalizeDestination("email",v)===v),subject:z.string().trim().min(1).max(200),body:z.string().trim().min(1).max(8000),category:z.literal("marketing"),reason:z.string().max(200).nullable()}).strict()}),
  z.object({type:z.literal("book_appointment"),payload:z.object({customer_id:z.string().uuid(),customer_name:z.string().trim().min(1).max(200),phone:z.string().refine(v=>normalizeDestination("sms",v)===v),email:z.string().refine(v=>normalizeDestination("email",v)===v).nullable(),car_info:z.string().max(200).nullable(),service:z.string().max(200).nullable(),iso_start_time:z.string().datetime({offset:true}),duration_minutes:z.number().int().min(15).max(1440),timezone:z.string().max(80).nullable(),pin_notes:z.string().max(2000).nullable()}).strict()}),
] as const

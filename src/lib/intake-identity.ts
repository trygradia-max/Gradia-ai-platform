import { z } from 'zod'
export const intakeCustomerSchema=z.object({id:z.string().uuid(),name:z.string().nullable(),phone:z.string().nullable(),email:z.string().nullable(),updated_at:z.string()}).strict()
export type IntakeCustomer=z.infer<typeof intakeCustomerSchema>
export const intakeLinkSchema=z.object({shopId:z.string().uuid(),workflowId:z.string().uuid(),revision:z.number().int().positive(),commandId:z.string().uuid(),customer:intakeCustomerSchema,confirmed:z.literal(true)}).strict()

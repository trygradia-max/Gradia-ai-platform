import { z } from "zod"
export const intakeVehicleSchema = z.object({
  id: z.string().uuid(), customer_id: z.string().uuid(), year: z.number().int().nullable(),
  make: z.string().nullable(), model: z.string().nullable(), color: z.string().nullable(),
  plate: z.string().nullable(), updated_at: z.string(),
}).strict()
export type IntakeVehicle = z.infer<typeof intakeVehicleSchema>
export const intakeVehicleChoicesSchema = z.object({
  customer_id: z.string().uuid(), customer_updated_at: z.string(),
  vehicles: z.array(intakeVehicleSchema).max(50),
})
export const intakeVehicleLinkSchema = z.object({
  shopId: z.string().uuid(), workflowId: z.string().uuid(), revision: z.number().int().positive(),
  commandId: z.string().uuid(), customerId: z.string().uuid(), customerUpdatedAt: z.string(),
  vehicle: intakeVehicleSchema, confirmed: z.literal(true),
}).strict().refine(value => value.customerId === value.vehicle.customer_id)

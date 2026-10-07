import {z} from 'zod'
export const managerNotificationSettingsSchema=z.object({mode:z.enum(['off','immediate','digest']),timezone:z.string().min(1).max(100),quiet_start:z.number().int().min(0).max(23),quiet_end:z.number().int().min(0).max(23),digest_hour:z.number().int().min(0).max(23),revision:z.number().int().min(0).max(2147483646)}).strict()
export const managerNotificationReadSchema=z.object({settings:managerNotificationSettingsSchema,history:z.array(z.object({id:z.string().uuid(),state:z.enum(['claimed','accepted','retry','unknown','failed','cancelled']),attempts:z.number().int(),item_count:z.number().int(),reason:z.string().nullable(),created_at:z.string(),recipient:z.string()})).max(20)})
export type ManagerNotificationRead=z.infer<typeof managerNotificationReadSchema>

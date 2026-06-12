import { z } from "zod"

/**
 * Carrier-facing compliance details for A2P 10DLC registration.
 * Validation is deliberately strict — the top rejection causes are fixable
 * input problems (EIN format, legal-name/EIN mismatch, vague details), so
 * we catch what we can before Twilio does. Shared by the wizard form, the
 * server action, and the tests.
 */
export const a2pBusinessSchema = z.object({
  legal_name: z
    .string()
    .trim()
    .min(2, "Enter the business's legal name — exactly as registered with the IRS."),
  ein: z
    .string()
    .trim()
    .transform((v) => v.replace(/[^0-9]/g, ""))
    .refine((v) => v.length === 9, "EIN is 9 digits (formatted like 12-3456789)."),
  business_type: z.enum(
    [
      "Sole Proprietorship",
      "Partnership",
      "Limited Liability Corporation",
      "Corporation",
      "Co-operative",
      "Non-profit Corporation",
    ],
    { message: "Pick the business structure." }
  ),
  website_url: z
    .string()
    .trim()
    .url("Enter a full URL (https://…) or leave it blank.")
    .nullable()
    .or(z.literal("").transform(() => null)),
  address: z.object({
    street: z.string().trim().min(3, "Street address is required."),
    city: z.string().trim().min(2, "City is required."),
    region: z
      .string()
      .trim()
      .toUpperCase()
      .refine((v) => /^[A-Z]{2}$/.test(v), "Two-letter state code (e.g. MA)."),
    postal_code: z
      .string()
      .trim()
      .refine((v) => /^\d{5}(-\d{4})?$/.test(v), "ZIP code looks off."),
  }),
  contact: z.object({
    first_name: z.string().trim().min(1, "First name is required."),
    last_name: z.string().trim().min(1, "Last name is required."),
    email: z.string().trim().email("Enter a valid email."),
    phone: z
      .string()
      .trim()
      .refine((v) => /^\+1\d{10}$/.test(v), "US phone in +1XXXXXXXXXX format."),
    job_position: z.string().trim().min(2, "Role at the business (e.g. Owner)."),
  }),
})

export type A2pFormInput = z.input<typeof a2pBusinessSchema>

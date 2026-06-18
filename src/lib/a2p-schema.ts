import { z } from "zod"

/**
 * Carrier-facing compliance details for A2P 10DLC registration.
 * Validation is deliberately strict — the top rejection causes are fixable
 * input problems (EIN format, legal-name/EIN mismatch, vague details), so
 * we catch what we can before Twilio does. Shared by the wizard form, the
 * server action, and the tests.
 *
 * Two carrier paths, forked on "Do you have an EIN?" (twilio-isv-telephony
 * skill):
 *   - has_ein: true  → Low-Volume Standard (secondary profile + EIN brand)
 *   - has_ein: false → SOLE_PROPRIETOR (starter profile, no tax ID; the
 *     owner's MOBILE gets a one-time verification text they must answer —
 *     a number can only ever be used 3× across all carrier registrations,
 *     so it must be the owner's real cell)
 */
export const a2pBusinessSchema = z.object({
  has_ein: z.boolean().default(true),
  legal_name: z
    .string()
    .trim()
    .min(2, "Enter the business name — for EIN registrations, exactly as registered with the IRS."),
  ein: z.preprocess(
    (v) => (v == null ? "" : v),
    z
      .string()
      .trim()
      .transform((v) => v.replace(/[^0-9]/g, ""))
      .refine(
        (v) => v.length === 9 || v.length === 0,
        "EIN is 9 digits (formatted like 12-3456789)."
      )
      .transform((v) => v || null)
  ),
  /** Sole-prop only: the owner's cell that receives the verification text. */
  mobile_phone: z.preprocess(
    (v) => (v == null ? "" : v),
    z
      .string()
      .trim()
      .refine(
        (v) => v === "" || /^\+1\d{10}$/.test(v),
        "US mobile in +1XXXXXXXXXX format."
      )
      .transform((v) => v || null)
  ),
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
}).superRefine((data, ctx) => {
  if (data.has_ein && !data.ein) {
    ctx.addIssue({
      code: "custom",
      path: ["ein"],
      message: "Enter the 9-digit EIN — or switch to \"No EIN\" if you don't have one.",
    })
  }
  if (!data.has_ein && !data.mobile_phone) {
    ctx.addIssue({
      code: "custom",
      path: ["mobile_phone"],
      message: "Carriers verify sole proprietors by texting the owner's cell — enter it.",
    })
  }
})

export type A2pFormInput = z.input<typeof a2pBusinessSchema>

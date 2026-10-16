import { z } from "zod"

/** A job description is data, never an execution grant or published memory. */
export const employeeBriefSchema = z.object({
  name: z.string().trim().min(2).max(80),
  goal: z.string().trim().min(10).max(2000),
  deliverable: z.string().trim().min(5).max(600),
  business_context: z.string().trim().max(3000),
  steps: z.array(z.string().trim().min(3).max(300)).min(1).max(8),
  connections_needed: z.array(z.string().trim().min(2).max(120)).max(8),
  questions: z.array(z.string().trim().min(3).max(300)).max(5),
}).strict()
export type EmployeeBrief = z.infer<typeof employeeBriefSchema>
export type EmployeeDraft = { id: string; brief: EmployeeBrief; created_at: string }
export const employeeRequestSchema = z.object({
  goal: z.string().trim().min(10).max(2000),
  context: z.string().trim().max(3000),
}).strict()
export const EMPLOYEE_TEMPLATES = [
  { name: "Google & SEO helper", goal: "Help my business show up on Google. Review my website and Business Profile, prioritize SEO problems, and prepare improvements for me to review." },
  { name: "Grant finder", goal: "Find business grants that could fit my business. Give me official sources, deadlines, eligibility questions and a checklist of what I need to apply." },
  { name: "Business researcher", goal: "Research a business problem I describe, compare the options and give me a practical recommendation with evidence." },
] as const

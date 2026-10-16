import { z } from "zod"

const NOTE_LIMIT = 8
const EXCERPT_LIMIT = 240

export const memoryNoteSchema = z.object({
  source_name: z.string().trim().min(1).max(80),
  excerpt: z.string().trim().min(1).max(EXCERPT_LIMIT),
}).strict()
export const memoryReadDetailSchema = z.object({
  version: z.literal(1),
  published: z.literal(false),
  lesson_created: z.literal(false),
  research_included: z.literal(false),
  notes: z.array(memoryNoteSchema).max(NOTE_LIMIT),
  summary: z.string().trim().min(1).max(300).refine(value => value.includes("did not publish"), "A memory read must say it did not publish."),
}).strict()
export type MemoryReadDetail = z.infer<typeof memoryReadDetailSchema>

export type BusinessNote = { source_name: string; content: string }

function clip(value: string, max: number): string {
  return value.trim().replace(/\s+/g, " ").slice(0, max).trim()
}

/** A read of notes the business already saved. It cannot publish a lesson or include a research result. */
export function memorySnapshot(notes: BusinessNote[]): MemoryReadDetail {
  const clipped = notes.flatMap(note => {
    const source_name = clip(note.source_name, 80)
    const excerpt = clip(note.content, EXCERPT_LIMIT)
    if (!source_name || !excerpt) return []
    return [{ source_name, excerpt }]
  }).slice(0, NOTE_LIMIT)
  const summary = clipped.length === 0
    ? "No saved business notes were found. This did not publish a lesson or include research results."
    : `Gradia read ${clipped.length} saved business ${clipped.length === 1 ? "note" : "notes"}. This did not publish a lesson or include research results.`
  return memoryReadDetailSchema.parse({
    version: 1, published: false, lesson_created: false, research_included: false, notes: clipped, summary,
  })
}

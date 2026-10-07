import { PipelineBoard } from "@/components/gradia/pipeline-board"
import { SectionHeader } from "@/components/gradia/section-header"
import { listPipelineForCurrentShop } from "@/lib/data/pipeline"
import { requireShop } from "@/lib/shop"
import { STRINGS } from "@/lib/strings"

export const dynamic = "force-dynamic"

/** Pipeline is its own destination (U-02). The board is the whole page. */
export default async function PipelinePage() {
  await requireShop()
  const pipeline = await listPipelineForCurrentShop()
  const s = STRINGS.pages.pipeline

  return (
    <div className="w-full space-y-6">
      <SectionHeader
        level={1}
        eyebrow={s.eyebrow}
        title={s.title}
        subhead={s.subtitle}
      />
      <PipelineBoard initial={pipeline} />
    </div>
  )
}

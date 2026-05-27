import type { Metadata } from "next"
import Link from "next/link"
import { ArrowUpRight } from "lucide-react"

import { SORTED_POSTS, formatDate } from "@/lib/blog"
import { GrainOverlay, MeshBackground } from "@/components/textures"
import { MotionCard } from "@/components/motion/motion-card"
import { RevealOnScroll, RevealItem } from "@/components/motion/reveal"

export const metadata: Metadata = {
  title: "Blog",
  description:
    "Field notes on running a detailing business in the age of AI — operations, retention, and how to keep a human in the loop.",
}

export default function BlogIndex() {
  const [featured, ...rest] = SORTED_POSTS

  return (
    <>
      <section className="relative isolate overflow-hidden px-5 pt-36 pb-12 sm:px-8 sm:pt-44">
        <MeshBackground />
        <GrainOverlay />
        <div className="mx-auto max-w-3xl">
          <p className="label-eyebrow text-muted-foreground/70">The Gradia blog</p>
          <h1 className="mt-4 font-display text-[clamp(2.5rem,7vw,4.5rem)] leading-[1.02] tracking-[-0.035em] text-foreground">
            Field notes for the <span className="italic text-primary">trade</span>.
          </h1>
          <p className="mt-5 max-w-xl text-lg leading-relaxed text-muted-foreground">
            Operations, retention, and the craft of running a detailing business
            without dropping the leads you worked hard to earn.
          </p>
        </div>
      </section>

      <div className="mx-auto max-w-5xl px-5 sm:px-8">
        {/* Featured */}
        <RevealOnScroll>
          <RevealItem>
            <Link href={`/blog/${featured.slug}`} data-cursor="cta">
              <MotionCard className="group grid overflow-hidden md:grid-cols-2">
                <div className="relative aspect-[16/10] overflow-hidden md:aspect-auto">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={featured.cover}
                    alt=""
                    className="size-full object-cover transition-transform duration-700 group-hover:scale-105"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-card/80 to-transparent md:bg-gradient-to-r" />
                </div>
                <div className="flex flex-col justify-center gap-4 p-7 sm:p-10">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="rounded-full bg-primary/10 px-2.5 py-0.5 font-medium text-primary ring-1 ring-primary/20">
                      {featured.tag}
                    </span>
                    <span>{formatDate(featured.date)}</span>
                    <span>·</span>
                    <span>{featured.readingTime}</span>
                  </div>
                  <h2 className="font-display text-[clamp(1.6rem,3.5vw,2.4rem)] leading-tight tracking-[-0.02em] text-foreground">
                    {featured.title}
                  </h2>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {featured.description}
                  </p>
                  <span className="inline-flex items-center gap-1 text-sm font-medium text-primary">
                    Read the post
                    <ArrowUpRight className="size-3.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                  </span>
                </div>
              </MotionCard>
            </Link>
          </RevealItem>
        </RevealOnScroll>

        {/* Rest */}
        <RevealOnScroll as="ul" className="mt-5 grid gap-5 sm:grid-cols-2">
          {rest.map((post) => (
            <RevealItem key={post.slug}>
              <Link href={`/blog/${post.slug}`} data-cursor="cta">
                <MotionCard className="group flex h-full flex-col overflow-hidden">
                  <div className="relative aspect-[16/10] overflow-hidden">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={post.cover}
                      alt=""
                      className="size-full object-cover transition-transform duration-700 group-hover:scale-105"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-card/60 to-transparent" />
                  </div>
                  <div className="flex flex-1 flex-col gap-3 p-6">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="rounded-full bg-primary/10 px-2.5 py-0.5 font-medium text-primary ring-1 ring-primary/20">
                        {post.tag}
                      </span>
                      <span>{post.readingTime}</span>
                    </div>
                    <h3 className="font-display text-xl leading-tight tracking-tight text-foreground">
                      {post.title}
                    </h3>
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      {post.description}
                    </p>
                  </div>
                </MotionCard>
              </Link>
            </RevealItem>
          ))}
        </RevealOnScroll>
      </div>
    </>
  )
}

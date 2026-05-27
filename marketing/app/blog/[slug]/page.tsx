import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft, ArrowRight } from "lucide-react"

import { POSTS, POST_CONTENT, getPost, formatDate } from "@/lib/blog"
import { SITE } from "@/lib/site"
import { cn } from "@/lib/utils"
import { buttonVariants } from "@/components/ui/button"
import { GrainOverlay, MeshBackground } from "@/components/textures"

export function generateStaticParams() {
  return POSTS.map((p) => ({ slug: p.slug }))
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const post = getPost(slug)
  if (!post) return {}
  return {
    title: post.title,
    description: post.description,
    openGraph: {
      title: post.title,
      description: post.description,
      type: "article",
      images: [post.cover],
    },
  }
}

export default async function BlogPostPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const post = getPost(slug)
  const load = POST_CONTENT[slug]
  if (!post || !load) notFound()

  const { default: Content } = await load()

  return (
    <article>
      {/* Header */}
      <header className="relative isolate overflow-hidden px-5 pt-32 pb-10 sm:px-8 sm:pt-40">
        <MeshBackground />
        <GrainOverlay />
        <div className="mx-auto max-w-3xl">
          <Link
            href="/blog"
            data-cursor="cta"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" /> All posts
          </Link>
          <div className="mt-6 flex items-center gap-2 text-xs text-muted-foreground">
            <span className="rounded-full bg-primary/10 px-2.5 py-0.5 font-medium text-primary ring-1 ring-primary/20">
              {post.tag}
            </span>
            <span>{formatDate(post.date)}</span>
            <span>·</span>
            <span>{post.readingTime}</span>
          </div>
          <h1 className="mt-4 font-display text-[clamp(2.1rem,5.5vw,3.5rem)] leading-[1.05] tracking-[-0.03em] text-foreground">
            {post.title}
          </h1>
          <p className="mt-4 text-lg leading-relaxed text-muted-foreground">
            {post.description}
          </p>
          <p className="mt-5 text-sm text-muted-foreground/80">
            By {post.author}
          </p>
        </div>
      </header>

      {/* Cover */}
      <div className="mx-auto max-w-3xl px-5 sm:px-8">
        <div className="overflow-hidden rounded-3xl border border-border/60">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={post.cover}
            alt={post.title}
            className="aspect-[16/9] w-full object-cover"
          />
        </div>
      </div>

      {/* Body */}
      <div className="mx-auto max-w-2xl px-5 py-14 sm:px-8">
        <div className="text-[1.0625rem]">
          <Content />
        </div>

        {/* End CTA */}
        <div className="mt-16 rounded-3xl border border-border/60 bg-card/40 p-8 text-center">
          <h2 className="font-display text-2xl tracking-tight text-foreground">
            Put an office behind your phone.
          </h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            ${SITE.price}/month. Gradia catches the lead you couldn&apos;t get
            to — and waits for your one tap before it sends.
          </p>
          <Link
            href={SITE.appUrl}
            data-cursor="cta"
            className={cn(buttonVariants({ size: "lg" }), "mt-5 h-12 px-6")}
          >
            Start free
            <ArrowRight className="size-4" aria-hidden />
          </Link>
        </div>
      </div>
    </article>
  )
}

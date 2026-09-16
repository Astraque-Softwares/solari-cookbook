import { notFound } from "next/navigation"

import { renderOgImage } from "@/lib/og"
import { docsPageTitle } from "@/lib/seo"
import { source } from "@/lib/source"

export const revalidate = false
export const dynamicParams = false

interface OgRouteContext {
  params: Promise<{ slug: string[] }>
}

/** Serves `/og/docs/<page slugs>/image.png`; the trailing segment keeps a real file extension. */
export async function GET(_request: Request, { params }: OgRouteContext) {
  const { slug } = await params
  const slugs = slug.slice(0, -1)
  const page = source.getPage(slugs)
  if (!page) {
    notFound()
  }

  return renderOgImage({
    description: page.data.description,
    eyebrow: ["docs", ...slugs.slice(0, -1)].join(" / "),
    title: docsPageTitle(slugs, page.data.title),
  })
}

export function generateStaticParams() {
  return source.getPages().map((page) => ({ slug: [...page.slugs, "image.png"] }))
}

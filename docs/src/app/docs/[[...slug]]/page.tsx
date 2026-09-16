import type { Metadata } from "next"
import { notFound } from "next/navigation"
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from "fumadocs-ui/layouts/docs/page"
import { createRelativeLink } from "fumadocs-ui/mdx"

import { getMDXComponents } from "@/components/mdx"
import { PageActions } from "@/components/page-actions"
import { docsOgImageUrl, docsPageTitle, pageMetadata, siteDescription } from "@/lib/seo"
import { markdownUrlFor, repoDocsUrl } from "@/lib/site"
import { source } from "@/lib/source"

interface DocumentationPageProps {
  params: Promise<{ slug?: string[] }>
}

export default async function DocumentationPage({ params }: DocumentationPageProps) {
  const { slug } = await params
  const page = source.getPage(slug)
  if (!page) {
    notFound()
  }

  const Content = page.data.body

  return (
    <DocsPage full={page.data.full} toc={page.data.toc}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription className="mb-4">{page.data.description}</DocsDescription>
      <PageActions
        githubUrl={`${repoDocsUrl}/${page.path}`}
        markdownUrl={markdownUrlFor(page.slugs)}
      />
      <DocsBody>
        <Content
          components={getMDXComponents({
            a: createRelativeLink(source, page),
          })}
        />
      </DocsBody>
    </DocsPage>
  )
}

export function generateStaticParams() {
  return source.generateParams()
}

export async function generateMetadata({ params }: DocumentationPageProps): Promise<Metadata> {
  const { slug } = await params
  const page = source.getPage(slug)
  if (!page) {
    notFound()
  }

  const isIndex = page.slugs.length === 0
  const title = docsPageTitle(page.slugs, page.data.title)

  return pageMetadata({
    description: page.data.description ?? siteDescription,
    image: docsOgImageUrl(page.slugs),
    path: page.url,
    socialTitle: isIndex ? "FlakeLab docs" : title,
    title: isIndex ? "Documentation" : title,
  })
}

import type { Metadata } from "next"

import { siteUrl } from "@/lib/site"

export const siteName = "FlakeLab"

export const siteTagline = "Find the trigger, prove the fix"

export const siteDescription =
  "FlakeLab finds, reproduces, explains, and proves fixes for flaky Playwright tests " +
  "with deterministic fault experiments, bounded AI reasoning, and disposable Solari sandboxes."

/** Command pages are titled by bare subcommand; out of context they read as `flakelab <name>`. */
export function docsPageTitle(slugs: string[], title: string): string {
  return slugs[0] === "commands" && slugs.length > 1 ? `flakelab ${title}` : title
}

export const ogImageSize = { height: 630, width: 1200 }

/** Absolute URL of the generated social card for a docs page. */
export function docsOgImageUrl(slugs: string[]): string {
  return `${siteUrl}/og/docs/${[...slugs, "image.png"].join("/")}`
}

interface PageMetadataInput {
  description: string
  /** Absolute URL of the social card. */
  image: string
  /** Site-relative path of the page, starting with `/`. */
  path: string
  /** Title used in social cards; the document title comes from the layout template. */
  socialTitle: string
  title?: Metadata["title"]
  type?: "article" | "website"
}

/**
 * Next.js replaces `openGraph` and `twitter` wholesale when a page defines
 * them, so every page must restate the shared fields or scrapers see a mix of
 * the page and the site defaults.
 */
export function pageMetadata({
  description,
  image,
  path,
  socialTitle,
  title,
  type = "article",
}: PageMetadataInput): Metadata {
  const url = `${siteUrl}${path}`
  const images = [{ alt: socialTitle, ...ogImageSize, type: "image/png", url: image }]

  return {
    alternates: { canonical: url },
    description,
    openGraph: {
      description,
      images,
      locale: "en_US",
      siteName,
      title: socialTitle,
      type,
      url,
    },
    title,
    twitter: {
      card: "summary_large_image",
      description,
      images,
      title: socialTitle,
    },
  }
}

import type { MetadataRoute } from "next"

import { siteUrl } from "@/lib/site"
import { source } from "@/lib/source"

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { changeFrequency: "weekly", priority: 1, url: siteUrl },
    ...source.getPages().map((page) => ({
      changeFrequency: "weekly" as const,
      priority: page.slugs.length === 0 ? 0.9 : 0.7,
      url: `${siteUrl}${page.url}`,
    })),
  ]
}

import type { MetadataRoute } from "next"

import { siteUrl } from "@/lib/site"

export default function robots(): MetadataRoute.Robots {
  return {
    host: siteUrl,
    rules: { allow: "/", disallow: "/api/", userAgent: "*" },
    sitemap: `${siteUrl}/sitemap.xml`,
  }
}

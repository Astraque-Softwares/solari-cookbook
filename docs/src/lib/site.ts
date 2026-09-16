function normalize(url: string): string {
  return url.replace(/\/+$/, "")
}

/**
 * Absolute origin of the deployed site.
 *
 * Agent deep links and the Markdown endpoints must hand out absolute URLs, so
 * this has to resolve to something an external assistant can fetch. Set
 * `NEXT_PUBLIC_SITE_URL` for the real domain; Vercel's production URL is used
 * automatically when it is available.
 */
export const siteUrl = normalize(
  process.env.NEXT_PUBLIC_SITE_URL
  ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : "https://flakelab.vercel.app"),
)

export const repoUrl = "https://github.com/kelvinguchu/solari-cookbook"

export const repoDocsUrl = `${repoUrl}/blob/main/docs/content/docs`

export const packageUrl = "https://www.npmjs.com/package/flakelab"

export const projectUrl = `${repoUrl}/tree/main/projects/flakelab`

/** Absolute URL of the plain-Markdown rendering of a docs page. */
export function markdownUrlFor(slugs: string[]): string {
  return `${siteUrl}/llms.mdx/${slugs.join("/")}`.replace(/\/$/, "")
}

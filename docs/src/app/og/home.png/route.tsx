import { renderOgImage } from "@/lib/og"
import { siteTagline } from "@/lib/seo"

export const revalidate = false

export function GET() {
  return renderOgImage({
    description:
      "Deterministic fault experiments, bounded AI reasoning, and fixes proven in disposable sandboxes.",
    eyebrow: "flaky Playwright tests, explained",
    title: siteTagline,
  })
}

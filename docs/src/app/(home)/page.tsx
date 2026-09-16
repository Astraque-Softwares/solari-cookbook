import type { Metadata } from "next"
import Link from "next/link"

import { AsciiField } from "@/components/ascii-field"
import { CopyCommand } from "@/components/copy-command"
import {
  ArtifactTable,
  BoundarySection,
  CommandMap,
  FaultCatalog,
  PipelineRail,
  PrincipleBanner,
} from "@/components/home/sections"
import { pageMetadata, siteDescription, siteName, siteTagline } from "@/lib/seo"
import { packageUrl, siteUrl } from "@/lib/site"

export const metadata: Metadata = {
  ...pageMetadata({
    description: siteDescription,
    image: `${siteUrl}/og/home.png`,
    path: "/",
    socialTitle: `${siteName} - ${siteTagline}`,
    title: { absolute: `${siteName} - ${siteTagline}` },
    type: "website",
  }),
  alternates: { canonical: siteUrl },
}

/**
 * Exactly one viewport tall, including the sticky 56px header above it, with
 * the content centred in the remaining space.
 */
function Hero() {
  return (
    <section className="fl-hero relative isolate flex flex-col overflow-hidden
      border-b border-fd-border">
      <AsciiField
        className="absolute inset-0 -z-10 h-full w-full opacity-50 md:opacity-70
          mask-[linear-gradient(to_bottom,transparent,black_18%,black_70%,transparent)]
          md:mask-[radial-gradient(120%_100%_at_85%_50%,black_10%,transparent_62%)]"
      />

      <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col justify-center
        px-6 py-10">
        <h1 className="max-w-3xl text-4xl leading-[1.06] font-medium tracking-tighter
          text-balance sm:text-5xl lg:text-6xl">
          Find the trigger.
          <br />
          Prove the fix.
        </h1>

        <p className="mt-7 max-w-xl text-sm leading-7 text-fd-muted-foreground">
          A flaky test is an uncontrolled experiment. FlakeLab makes it a controlled one:
          deterministic fault injection with matched clean controls, bounded AI reasoning,
          and a candidate patch proven inside a disposable Solari microVM.
        </p>

        <div className="mt-8 max-w-xl">
          <CopyCommand command="npx flakelab@latest diagnose tests/checkout.spec.ts" />
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Link
            className="border border-fd-foreground bg-fd-foreground px-5 py-2.5 text-xs
              font-medium text-fd-background transition-opacity hover:opacity-85
              focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fd-ring"
            href="/docs/quick-start"
          >
            Quick start
          </Link>
          <Link
            className="border border-fd-border bg-fd-background px-5 py-2.5 text-xs
              transition-colors hover:bg-fd-accent focus-visible:outline-2
              focus-visible:outline-offset-2 focus-visible:outline-fd-ring"
            href="/docs"
          >
            Documentation
          </Link>
          <a
            className="px-2 py-2.5 text-xs text-fd-muted-foreground transition-colors
              hover:text-fd-foreground"
            href={packageUrl}
            rel="noreferrer noopener"
            target="_blank"
          >
            npm ↗
          </a>
        </div>
      </div>
    </section>
  )
}

export default function HomePage() {
  return (
    <>
      <Hero />
      <PipelineRail />
      <PrincipleBanner />
      <CommandMap />
      <FaultCatalog />
      <ArtifactTable />
      <BoundarySection />
    </>
  )
}

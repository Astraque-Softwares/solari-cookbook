import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { ImageResponse } from "next/og"

import { ogImageSize } from "@/lib/seo"
import { siteUrl } from "@/lib/site"

const fontDir = join(process.cwd(), "node_modules/geist/dist/fonts/geist-mono")

// Satori cannot read variable fonts or woff2, so the static TTF cuts are loaded.
// Cards are rendered at build time, so these files are never read at runtime.
async function loadAssets() {
  const [regular, medium, logo] = await Promise.all([
    readFile(join(fontDir, "GeistMono-Regular.ttf")),
    readFile(join(fontDir, "GeistMono-Medium.ttf")),
    readFile(join(process.cwd(), "public/logo-light.png")),
  ])
  return { logo: `data:image/png;base64,${logo.toString("base64")}`, medium, regular }
}

let assets: ReturnType<typeof loadAssets> | undefined

function titleSize(title: string): number {
  if (title.length <= 18) return 88
  if (title.length <= 34) return 68
  return 54
}

interface OgImageInput {
  description?: string
  /** Short breadcrumb shown above the title, such as `docs / commands`. */
  eyebrow: string
  title: string
}

/** Renders the 1200x630 social card shared by every page. */
export async function renderOgImage({ description, eyebrow, title }: OgImageInput) {
  assets ??= loadAssets()
  const { logo, medium, regular } = await assets
  const host = new URL(siteUrl).host

  return new ImageResponse(
    (
      <div
        style={{
          backgroundColor: "#060c12",
          backgroundImage:
            "linear-gradient(rgba(234,242,244,0.05) 1px, transparent 1px), " +
            "linear-gradient(90deg, rgba(234,242,244,0.05) 1px, transparent 1px)",
          backgroundSize: "48px 48px",
          color: "#eaf2f4",
          display: "flex",
          flexDirection: "column",
          fontFamily: "Geist Mono",
          height: "100%",
          padding: "64px 72px",
          width: "100%",
        }}
      >
        <div style={{ alignItems: "center", display: "flex", gap: 20 }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- Satori renders plain img only */}
          <img alt="" height={50} src={logo} width={69} />
          <span style={{ fontSize: 34, fontWeight: 500, letterSpacing: -1 }}>FlakeLab</span>
        </div>

        <div
          style={{
            display: "flex",
            flex: 1,
            flexDirection: "column",
            justifyContent: "center",
          }}
        >
          <div style={{ color: "#27d3c2", fontSize: 26, marginBottom: 24 }}>{eyebrow}</div>
          <div
            style={{
              display: "flex",
              fontSize: titleSize(title),
              fontWeight: 500,
              letterSpacing: -2,
              lineHeight: 1.08,
              maxWidth: 1000,
            }}
          >
            {title}
          </div>
          {description ? (
            <div
              style={{
                color: "#8fa3ad",
                display: "flex",
                fontSize: 28,
                lineHeight: 1.45,
                marginTop: 28,
                maxWidth: 980,
              }}
            >
              {description.length > 150 ? `${description.slice(0, 147).trimEnd()}...` : description}
            </div>
          ) : null}
        </div>

        <div
          style={{
            borderTop: "1px solid #162331",
            color: "#8fa3ad",
            display: "flex",
            fontSize: 22,
            justifyContent: "space-between",
            paddingTop: 24,
          }}
        >
          <span>{host}</span>
          <span style={{ color: "#b7f34a" }}>npx flakelab@latest</span>
        </div>
      </div>
    ),
    {
      ...ogImageSize,
      fonts: [
        { data: regular, name: "Geist Mono", style: "normal", weight: 400 },
        { data: medium, name: "Geist Mono", style: "normal", weight: 500 },
      ],
    },
  )
}

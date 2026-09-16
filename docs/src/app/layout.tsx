import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { GeistMono } from "geist/font/mono";
import { RootProvider } from "fumadocs-ui/provider/next";

import { pageMetadata, siteDescription, siteName, siteTagline } from "@/lib/seo";
import { repoUrl, siteUrl } from "@/lib/site";

import "./global.css";

const defaultTitle = `${siteName} - ${siteTagline}`;

const defaults = pageMetadata({
  description: siteDescription,
  image: `${siteUrl}/og/home.png`,
  path: "/",
  socialTitle: defaultTitle,
  title: {
    default: defaultTitle,
    template: `%s - ${siteName}`,
  },
  type: "website",
});

export const metadata: Metadata = {
  ...defaults,
  // Canonical URLs are set per page; a layout-level one would leak onto every route.
  alternates: undefined,
  applicationName: siteName,
  authors: [{ name: "Kelvin Guchu", url: repoUrl }],
  category: "technology",
  creator: "Kelvin Guchu",
  keywords: [
    "flaky tests",
    "Playwright",
    "test flakiness",
    "fault injection",
    "test reliability",
    "CI",
    "end-to-end testing",
    "FlakeLab",
    "Solari",
  ],
  metadataBase: new URL(siteUrl),
  robots: { follow: true, index: true },
};

export const viewport: Viewport = {
  themeColor: [
    { color: "#ffffff", media: "(prefers-color-scheme: light)" },
    { color: "#060c12", media: "(prefers-color-scheme: dark)" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html className={GeistMono.variable} lang='en' suppressHydrationWarning>
      <body className='flex min-h-screen flex-col antialiased'>
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}

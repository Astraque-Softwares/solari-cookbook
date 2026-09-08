import type { Page } from "@playwright/test"

import type {
  Fault,
  LocaleFault,
  ReducedMotionFault,
  TimezoneFault,
  ViewportFault,
} from "../domain/schema.js"

export type BrowserContextFault = LocaleFault | ReducedMotionFault | TimezoneFault | ViewportFault
type PageContextFault = ReducedMotionFault | ViewportFault

export interface BrowserContextFaultOptions {
  locale?: string
  reducedMotion?: "reduce"
  timezoneId?: string
  viewport?: { height: number; width: number }
}

export function isBrowserContextFault(fault: Fault): fault is BrowserContextFault {
  return fault.kind === "locale"
    || fault.kind === "reduced-motion"
    || fault.kind === "timezone"
    || fault.kind === "viewport"
}

export function isImmutableBrowserContextFault(fault: Fault): fault is LocaleFault | TimezoneFault {
  return fault.kind === "locale" || fault.kind === "timezone"
}

export function browserContextFaultOptions(
  faults: readonly Fault[],
): BrowserContextFaultOptions {
  const locale = faults.find((fault): fault is LocaleFault => fault.kind === "locale")
  const reducedMotion = faults.find((fault): fault is ReducedMotionFault =>
    fault.kind === "reduced-motion")
  const timezone = faults.find((fault): fault is TimezoneFault => fault.kind === "timezone")
  const viewport = faults.find((fault): fault is ViewportFault => fault.kind === "viewport")
  return {
    ...(locale ? { locale: locale.locale } : {}),
    ...(reducedMotion ? { reducedMotion: "reduce" as const } : {}),
    ...(timezone ? { timezoneId: timezone.timezoneId } : {}),
    ...(viewport ? { viewport: { height: viewport.height, width: viewport.width } } : {}),
  }
}

/** Chromium launch flags also reach contexts created directly with browser.newPage(). */
export function browserLaunchFaultArguments(faults: readonly Fault[]): string[] {
  return faults.some((fault) => fault.kind === "reduced-motion")
    ? ["--force-prefers-reduced-motion"]
    : []
}

function isPageContextFault(fault: Fault): fault is PageContextFault {
  return fault.kind === "reduced-motion" || fault.kind === "viewport"
}

export async function installPageContextFaults(
  page: Page,
  faults: readonly Fault[],
): Promise<() => Promise<void>> {
  const pageFaults = faults.filter(isPageContextFault)
  if (pageFaults.length === 0) {
    return () => Promise.resolve()
  }
  const viewport = pageFaults.find((fault): fault is ViewportFault => fault.kind === "viewport")
  const reducedMotion = pageFaults.some((fault) => fault.kind === "reduced-motion")
  const baselineViewport = page.viewportSize()
  if (viewport && !baselineViewport) {
    throw new Error("Direct viewport injection requires an existing emulated viewport")
  }
  const baselineReducedMotion = await page.evaluate(() =>
    matchMedia("(prefers-reduced-motion: reduce)").matches)
  if (viewport) {
    await page.setViewportSize({ height: viewport.height, width: viewport.width })
  }
  try {
    if (reducedMotion) {
      await page.emulateMedia({ reducedMotion: "reduce" })
    }
  } catch (error) {
    if (viewport && baselineViewport) {
      await page.setViewportSize(baselineViewport)
    }
    throw error
  }
  return async () => {
    if (reducedMotion) {
      await page.emulateMedia({ reducedMotion: baselineReducedMotion ? "reduce" : "no-preference" })
    }
    if (viewport && baselineViewport) {
      await page.setViewportSize(baselineViewport)
    }
  }
}

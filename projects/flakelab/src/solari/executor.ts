import type { Browser } from "@playwright/test"
import { chromium } from "@playwright/test"
import { Solari } from "@solarisdk/browser"
import type { Sandbox } from "@solarisdk/sandbox"
import { SandboxClient } from "@solarisdk/sandbox"
import { z } from "zod"

import { createHash } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import type { TrialOutcome, TrialPlan } from "../domain/schema.js"
import { installFault } from "../faults/install.js"
import type { TrialExecutor } from "../runner/playwright-executor.js"
import {
  CHECKOUT_APP_DIRECTORY,
  CHECKOUT_PORT,
  checkoutServerSource,
} from "./checkout-fixture.js"
import { retryTransient } from "./retry.js"
import type { ResourceUsage } from "./usage.js"
import { ResourceUsageTracker } from "./usage.js"
import { SecureWebSocketProxy } from "./websocket-proxy.js"

const SANDBOX_TIMEOUT_MS = 5 * 60_000
const PREVIEW_ATTEMPTS = 20

interface RemoteBrowser {
  browser: Browser
  proxy: SecureWebSocketProxy
  sessionId: string
}

const rawSessionSchema = z.object({
  sessionId: z.string().min(1),
  cdpEndpoint: z.url(),
})

export interface SolariExecutorOptions {
  apiKey: string
  baseUrl: string
  signal?: AbortSignal
  snapshotName: string
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16)
}

function errorFingerprint(error: Error): string {
  return fingerprint(`${error.name}:${error.message}`)
}

async function waitForPreview(url: string, signal?: AbortSignal): Promise<void> {
  for (let attempt = 1; attempt <= PREVIEW_ATTEMPTS; attempt += 1) {
    signal?.throwIfAborted()
    try {
      const response = await fetch(url, { signal })
      if (response.ok) {
        return
      }
    } catch (error) {
      if (signal?.aborted) {
        throw error
      }
    }
    await delay(500, undefined, { signal })
  }
  throw new Error("Solari preview did not become ready")
}

export class SolariParallelExecutor {
  readonly #browsers: Solari
  readonly #options: SolariExecutorOptions
  readonly #sandboxes: SandboxClient
  readonly #tracker = new ResourceUsageTracker()
  readonly #liveBrowsers = new Map<string, RemoteBrowser>()
  readonly #liveSandboxes = new Map<string, Sandbox>()
  #previewUrl: string | undefined
  #snapshotId: string | undefined

  constructor(options: SolariExecutorOptions) {
    this.#options = options
    this.#sandboxes = new SandboxClient({ apiKey: options.apiKey, baseUrl: options.baseUrl })
    this.#browsers = new Solari({ apiKey: options.apiKey, baseUrl: options.baseUrl })
  }

  async prepare(): Promise<void> {
    this.#options.signal?.throwIfAborted()
    const cachedSnapshots = await retryTransient(
      async () => this.#sandboxes.listSnapshots({ template: "base", limit: 100 }),
      this.#retryOptions(),
    )
    const cached = cachedSnapshots.snapshots.find((snapshot) =>
      snapshot.kind === "sandbox" && snapshot.name === this.#options.snapshotName)
    if (cached) {
      this.#snapshotId = cached.id
      this.#tracker.snapshotCacheHit()
      await this.#createSharedTarget()
      return
    }
    const source = await retryTransient(async () => this.#sandboxes.create({
      template: "base",
      timeoutMs: SANDBOX_TIMEOUT_MS,
      metadata: { product: "flakelab", role: "source" },
    }), this.#retryOptions())
    this.#trackSandbox(source)
    try {
      await source.connect()
      await source.files.write(`${CHECKOUT_APP_DIRECTORY}/server.py`, checkoutServerSource)
      const command = await source.commands.run("sh", {
        args: [
          "-c",
          `cd ${CHECKOUT_APP_DIRECTORY} && nohup python3 server.py >server.log 2>&1 &`,
        ],
      })
      if (command.exitCode !== 0) {
        throw new Error("Checkout fixture failed to start in the prepared sandbox")
      }
      const preview = await source.previewUrl(CHECKOUT_PORT)
      await waitForPreview(preview.url, this.#options.signal)
      this.#snapshotId = await source.snapshot(this.#options.snapshotName)
    } finally {
      await this.#releaseSandbox(source)
    }
    await this.#createSharedTarget()
  }

  readonly execute: TrialExecutor = async (trial) => {
    const startedAt = this.#tracker.trialStarted()
    let browser: RemoteBrowser | undefined
    let outcome: TrialOutcome
    let cleanupFailed = false

    try {
      this.#options.signal?.throwIfAborted()
      if (!this.#previewUrl) {
        throw new Error("Solari executor must be prepared before trials run")
      }
      browser = await this.#createBrowser()
      this.#trackBrowser(browser)
      outcome = await this.#exerciseCheckout(browser.browser, this.#previewUrl, trial, startedAt)
    } catch (error) {
      const cause = error instanceof Error ? error : new Error("Solari trial failed")
      outcome = {
        status: "error",
        durationMs: Date.now() - startedAt,
        exitCode: null,
        failureSignature: errorFingerprint(cause),
      }
    } finally {
      if (browser) {
        cleanupFailed = !(await this.#releaseBrowser(browser)) || cleanupFailed
      }
      this.#tracker.trialCompleted(startedAt)
    }

    if (cleanupFailed) {
      return {
        status: "error",
        durationMs: Date.now() - startedAt,
        exitCode: null,
        failureSignature: fingerprint("solari-resource-cleanup-failed"),
      }
    }
    return outcome
  }

  usage(): ResourceUsage {
    return this.#tracker.snapshot()
  }

  async close(): Promise<void> {
    const released = await Promise.all([
      ...[...this.#liveBrowsers.values()].map(async (browser) => this.#releaseBrowser(browser)),
      ...[...this.#liveSandboxes.values()].map(async (sandbox) => this.#releaseSandbox(sandbox)),
    ])
    await this.#browsers.close()
    if (released.some((clean) => !clean)) {
      throw new Error("One or more Solari resources could not be confirmed as released")
    }
  }

  snapshotId(): string {
    if (!this.#snapshotId) {
      throw new Error("Solari executor has not prepared a snapshot")
    }
    return this.#snapshotId
  }

  async #createSharedTarget(): Promise<void> {
    if (!this.#snapshotId) {
      throw new Error("Solari executor must be prepared before trials run")
    }
    const fork = await retryTransient(async () => this.#sandboxes.create({
      template: "base",
      fromSnapshot: this.#snapshotId,
      timeoutMs: SANDBOX_TIMEOUT_MS,
      lifecycle: { onTimeout: "kill" },
      metadata: { product: "flakelab", role: "shared-target" },
    }), this.#retryOptions())
    this.#trackSandbox(fork)
    await retryTransient(async () => fork.connect(), {
      attempts: 3,
      baseDelayMs: 250,
      signal: this.#options.signal,
      onRetry: () => {
        this.#tracker.retry()
      },
    })
    const preview = await fork.previewUrl(CHECKOUT_PORT)
    await waitForPreview(preview.url, this.#options.signal)
    this.#previewUrl = preview.url
  }

  #retryOptions(): {
    attempts: number
    baseDelayMs: number
    signal?: AbortSignal
    onRetry: () => void
  } {
    return {
      attempts: 3,
      baseDelayMs: 250,
      signal: this.#options.signal,
      onRetry: () => {
        this.#tracker.retry()
      },
    }
  }

  async #exerciseCheckout(
    browser: Browser,
    previewUrl: string,
    trial: TrialPlan,
    startedAt: number,
  ): Promise<TrialOutcome> {
    const context = await browser.newContext()
    const page = await context.newPage()
    const removeFault = trial.fault ? await installFault(page, trial.fault) : undefined
    try {
      await page.goto(previewUrl)
      await page.getByRole("button", { name: "Place order" }).click()
      const status = page.getByRole("status")
      await status.filter({ hasText: /Checkout complete|Checkout timed out/ }).waitFor()
      const statusText = await status.textContent()
      const passed = statusText === "Checkout complete"
      return {
        status: passed ? "passed" : "failed",
        durationMs: Date.now() - startedAt,
        exitCode: passed ? 0 : 1,
        ...(passed ? {} : { failureSignature: fingerprint(`checkout:${statusText ?? "missing"}`) }),
      }
    } finally {
      if (removeFault) {
        await removeFault()
      }
      await context.close()
    }
  }

  async #createBrowser(): Promise<RemoteBrowser> {
    const response = await retryTransient(
      async () => this.#browsers.request("POST", "/sessions"),
      this.#retryOptions(),
    )
    if (!response.ok) {
      throw new Error(`Solari browser session creation failed with HTTP ${response.status}`)
    }
    const session = rawSessionSchema.parse(await response.json())
    this.#tracker.browserCreated()
    let proxy: SecureWebSocketProxy | undefined
    try {
      proxy = await SecureWebSocketProxy.create(session.cdpEndpoint)
      const browser = await chromium.connectOverCDP(proxy.endpoint())
      return { browser, proxy, sessionId: session.sessionId }
    } catch (error) {
      await proxy?.close().catch(() => undefined)
      await this.#browsers.sessions.releaseAndWait(session.sessionId).catch(() => undefined)
      this.#tracker.browserClosed()
      throw error
    }
  }

  #trackBrowser(browser: RemoteBrowser): void {
    this.#liveBrowsers.set(browser.sessionId, browser)
  }

  #trackSandbox(sandbox: Sandbox): void {
    this.#liveSandboxes.set(sandbox.id, sandbox)
    this.#tracker.sandboxCreated()
  }

  async #releaseBrowser(remote: RemoteBrowser): Promise<boolean> {
    let clean = true
    try {
      await remote.browser.close()
    } catch {
      clean = false
    }
    try {
      await remote.proxy.close()
    } catch {
      clean = false
    }
    try {
      await this.#browsers.sessions.releaseAndWait(remote.sessionId)
    } catch {
      clean = false
    }
    if (clean && this.#liveBrowsers.delete(remote.sessionId)) {
      this.#tracker.browserClosed()
    }
    return clean
  }

  async #releaseSandbox(sandbox: Sandbox): Promise<boolean> {
    try {
      await sandbox.kill()
      if (this.#liveSandboxes.delete(sandbox.id)) {
        this.#tracker.sandboxKilled()
      }
      return true
    } catch {
      return false
    }
  }
}

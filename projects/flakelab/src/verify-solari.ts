import type { BrowserSession } from "@solarisdk/browser"
import { Solari } from "@solarisdk/browser"
import { SandboxClient } from "@solarisdk/sandbox"
import { config as loadEnv } from "dotenv"

import { mkdir, stat } from "node:fs/promises"
import { resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { withSolariTransport } from "./solari/transport.js"

loadEnv({ path: resolve(import.meta.dirname, "../.env"), quiet: true })

const PORT = 4173
const READY_TEXT = "solari-verification-ready"
const SANDBOX_TIMEOUT_MS = 5 * 60_000
const INJECTED_DELAY_MS = 750
const REPLAY_ATTEMPTS = 5
const ARTIFACT_DIR = resolve(import.meta.dirname, "../.flakelab/artifacts/solari-verification")
const TRACE_PATH = resolve(ARTIFACT_DIR, "trace.zip")
const SANDBOX_APP_DIR = "/opt/flakelab-verification"

type SandboxHandle = Awaited<ReturnType<SandboxClient["create"]>>

const serverSource = `
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HTML = b'''<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>FlakeLab Solari Verification</title></head>
  <body>
    <main>
      <h1>FlakeLab Solari Verification</h1>
      <p data-testid="result">loading</p>
    </main>
    <script>
      fetch('/api/status')
        .then((response) => response.json())
        .then((body) => {
          document.querySelector('[data-testid="result"]').textContent = body.status
        })
        .catch(() => {
          document.querySelector('[data-testid="result"]').textContent = 'request-failed'
        })
    </script>
  </body>
</html>'''

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/api/status':
            body = json.dumps({'status': '${READY_TEXT}'}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
        else:
            body = HTML
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        return

ThreadingHTTPServer(('0.0.0.0', ${PORT}), Handler).serve_forever()
`

function requireApiKey(): string {
  const apiKey = process.env.SOLARI_API_KEY?.trim()
  if (!apiKey) {
    throw new Error(
      "SOLARI_API_KEY is missing. Export it in this shell or add SOLARI_API_KEY=... to the repository root .env file.",
    )
  }
  return apiKey
}

async function waitForHttp(url: string, attempts = 20): Promise<void> {
  let lastStatus = "no response"
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url)
      lastStatus = `HTTP ${response.status}`
      if (response.ok) {
        return
      }
    } catch (error) {
      lastStatus = error instanceof Error ? error.message : String(error)
    }
    await delay(500)
  }
  throw new Error(`Preview did not become ready: ${lastStatus}`)
}

function getBaseUrl(): string {
  const configuredUrl = process.env.SOLARI_BASE_URL?.trim()
  return configuredUrl ?? "https://api.getsolari.com"
}

async function createSourceSandbox(sandboxes: SandboxClient): Promise<SandboxHandle> {
  console.log("[1/7] Creating source sandbox")
  const sandbox = await sandboxes.create({
    template: "base",
    timeoutMs: SANDBOX_TIMEOUT_MS,
  })
  try {
    await sandbox.connect()
    await sandbox.files.write(`${SANDBOX_APP_DIR}/server.py`, serverSource)
    await sandbox.commands.run("sh", {
      args: [
        "-c",
        `cd ${SANDBOX_APP_DIR} && nohup python3 server.py >server.log 2>&1 &`,
      ],
    })
    const sourcePreview = await sandbox.previewUrl(PORT)
    await waitForHttp(sourcePreview.url)
    console.log("[2/7] Source preview is healthy")
    return sandbox
  } catch (error) {
    await sandbox.kill().catch(() => undefined)
    throw error
  }
}

async function createFork(sandboxes: SandboxClient, source: SandboxHandle): Promise<SandboxHandle> {
  console.log("[3/7] Snapshotting source sandbox")
  const snapshotId = await source.snapshot("flakelab-verification-ready")

  console.log("[4/7] Forking sandbox from snapshot")
  const fork = await sandboxes.create({
    template: "base",
    fromSnapshot: snapshotId,
    timeoutMs: SANDBOX_TIMEOUT_MS,
  })
  try {
    await fork.connect()
    const forkPreview = await fork.previewUrl(PORT)
    await waitForHttp(forkPreview.url)
    console.log("[5/7] Fork preview is healthy")
    return fork
  } catch (error) {
    await fork.kill().catch(() => undefined)
    throw error
  }
}

async function exerciseBrowser(browser: BrowserSession, previewUrl: string): Promise<void> {
  await mkdir(ARTIFACT_DIR, { recursive: true })
  const context = await browser.newContext()
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true })
  try {
    const page = await context.newPage()
    let delayedRequestCount = 0
    await page.route("**/api/status", async (route) => {
      delayedRequestCount += 1
      await delay(INJECTED_DELAY_MS)
      await route.continue()
    })

    const startedAt = performance.now()
    await page.goto(previewUrl)
    await page.getByTestId("result").waitFor({ state: "visible" })
    await page.getByTestId("result").filter({ hasText: READY_TEXT }).waitFor()
    const elapsedMs = Math.round(performance.now() - startedAt)

    if (delayedRequestCount === 0) {
      throw new Error("The browser route never observed /api/status")
    }
    if (elapsedMs < INJECTED_DELAY_MS) {
      throw new Error(`Latency injection was not reflected in runtime (${elapsedMs} ms)`)
    }
    console.log(`      Trigger confirmed: ${INJECTED_DELAY_MS} ms API delay; ready in ${elapsedMs} ms`)
  } finally {
    await context.tracing.stop({ path: TRACE_PATH })
    await context.close()
  }

  const traceBytes = (await stat(TRACE_PATH)).size
  if (traceBytes === 0) {
    throw new Error("Playwright trace was empty")
  }
  console.log(`      Playwright trace: ${traceBytes} bytes at ${TRACE_PATH}`)
}

async function downloadReplay(browsers: Solari, sessionId: string): Promise<Uint8Array | undefined> {
  for (let attempt = 1; attempt <= REPLAY_ATTEMPTS; attempt += 1) {
    await delay(1_000 * attempt)
    try {
      return await browsers.sessions.downloadReplay(sessionId)
    } catch (error) {
      const status =
        typeof error === "object" && error !== null && "status" in error
          ? Number(error.status)
          : undefined
      if (status !== 404) {
        throw error
      }
      console.log(`      Replay not uploaded yet (attempt ${attempt}/${REPLAY_ATTEMPTS})`)
    }
  }
  return undefined
}

function reportReplay(replay: Uint8Array | undefined): void {
  if (!replay) {
    console.warn("      Solari replay unavailable; continuing with the verified Playwright trace")
    return
  }
  const replayText = new TextDecoder().decode(replay)
  const eventCount = replayText.split("\n").filter(Boolean).length
  console.log(`      Solari replay: ${replay.byteLength} bytes, ${eventCount} rrweb events`)
}

async function verifyBrowser(browsers: Solari, previewUrl: string): Promise<void> {
  console.log("[6/7] Running a recorded browser with injected API latency")
  const browser = await browsers.launch({ recording: true })
  try {
    await exerciseBrowser(browser, previewUrl)
    console.log("[7/7] Saving the trace and checking the optional Solari replay")
  } finally {
    await delay(2_000)
    await browser.close()
  }
  reportReplay(await downloadReplay(browsers, browser.id))
}

async function main(): Promise<void> {
  const apiKey = requireApiKey()
  const baseUrl = getBaseUrl()
  const sandboxes = new SandboxClient({ apiKey, baseUrl })
  const browsers = new Solari({ apiKey, baseUrl })
  let source: SandboxHandle | undefined
  let fork: SandboxHandle | undefined

  try {
    source = await createSourceSandbox(sandboxes)
    fork = await createFork(sandboxes, source)
    const preview = await fork.previewUrl(PORT)
    await verifyBrowser(browsers, preview.url)
    console.log("\nSolari verification passed: every high-risk platform capability is feasible.")
  } finally {
    await browsers.close().catch(() => undefined)
    if (fork) {
      await fork.kill().catch(() => undefined)
    }
    if (source) {
      await source.kill().catch(() => undefined)
    }
  }
}

try {
  await withSolariTransport(main)
} catch (error) {
  console.error("\nSolari verification failed:", error instanceof Error ? error.message : error)
  process.exitCode = 1
}

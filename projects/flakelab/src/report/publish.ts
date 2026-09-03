import { SandboxClient } from "@solarisdk/sandbox"
import { readFile } from "node:fs/promises"
import { createInterface } from "node:readline/promises"
import { setTimeout as delay } from "node:timers/promises"

const REPORT_PORT = 4_173
const PUBLICATION_TIMEOUT_MS = 60 * 60_000
const PREVIEW_ATTEMPTS = 20

interface PublishOptions {
  apiKey: string
  baseUrl: string
}

export interface PublishedReport {
  expiresAt: string
  sandboxId: string
  url: string
}

export async function confirmReportPublication(): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("--publish requires an interactive terminal for explicit confirmation")
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await prompt.question(
      "Publish the redacted report to a public Solari URL for up to 60 minutes? [y/N] ",
    )
    return answer.trim().toLowerCase() === "y"
  } finally {
    prompt.close()
  }
}

async function waitForPreview(url: string): Promise<void> {
  for (let attempt = 1; attempt <= PREVIEW_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url)
      if (response.ok) {
        return
      }
    } catch {
      // The preview route can briefly lead the server during startup.
    }
    await delay(500)
  }
  throw new Error("Published report did not become reachable")
}

export async function publishReport(
  reportPath: string,
  options: PublishOptions,
): Promise<PublishedReport> {
  const client = new SandboxClient({ apiKey: options.apiKey, baseUrl: options.baseUrl })
  const sandbox = await client.create({
    template: "base",
    timeoutMs: PUBLICATION_TIMEOUT_MS,
    lifecycle: { onTimeout: "kill" },
    metadata: { product: "flakelab", role: "published-report" },
  })
  try {
    await sandbox.connect()
    await sandbox.files.mkdir("/work/flakelab-report")
    await sandbox.files.write(
      "/work/flakelab-report/index.html",
      await readFile(reportPath),
    )
    const server = await sandbox.commands.run("python3", {
      args: ["-m", "http.server", String(REPORT_PORT), "--bind", "0.0.0.0"],
      background: true,
      cwd: "/work/flakelab-report",
    })
    if (server.exitCode !== 0) {
      throw new Error("Solari could not start the report server")
    }
    const preview = await sandbox.previewUrl(REPORT_PORT)
    await waitForPreview(preview.url)
    sandbox.close()
    return { expiresAt: sandbox.expiresAt, sandboxId: sandbox.id, url: preview.url }
  } catch (error) {
    sandbox.close()
    await sandbox.kill()
    throw error
  }
}

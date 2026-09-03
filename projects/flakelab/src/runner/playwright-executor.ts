
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { TrialOutcome, TrialPlan } from "../domain/schema.js"

const MAX_DIAGNOSTIC_BYTES = 64 * 1024
const bundledPlaywrightCliPath = fileURLToPath(import.meta.resolve("@playwright/test/cli"))

export type TrialExecutor = (trial: TrialPlan) => Promise<TrialOutcome>

interface ExecutorOptions {
  signal?: AbortSignal
}

export function resolvePlaywrightCliPath(projectRoot: string): string {
  const projectRequire = createRequire(join(projectRoot, "package.json"))
  try {
    return projectRequire.resolve("@playwright/test/cli")
  } catch {
    return bundledPlaywrightCliPath
  }
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16)
}

function appendBounded(current: string, chunk: Buffer): string {
  return `${current}${chunk.toString("utf8")}`.slice(-MAX_DIAGNOSTIC_BYTES)
}

function createTrialEnvironment(trial: TrialPlan): NodeJS.ProcessEnv {
  return {
    ...process.env,
    FLAKELAB_FAULT_KIND: trial.fault?.kind ?? "",
    FLAKELAB_TRIAL_SEED: String(trial.seed),
    FLAKELAB_NETWORK_DELAY_MS: String(
      trial.fault?.kind === "network-delay" ? trial.fault.delayMs : 0,
    ),
    FLAKELAB_NETWORK_PATTERN: trial.fault?.pattern ?? "",
    FLAKELAB_REQUEST_FAILURE_STATUS: String(
      trial.fault?.kind === "request-failure" ? trial.fault.statusCode : 0,
    ),
  }
}

function stripAnsi(value: string): string {
  let result = ""
  let escapeState = 0
  for (const character of value) {
    if (escapeState === 0 && character === String.fromCharCode(27)) {
      escapeState = 1
    } else if (escapeState === 1) {
      escapeState = character === "[" ? 2 : 0
    } else if (escapeState === 2) {
      const code = character.codePointAt(0) ?? 0
      escapeState = code >= 0x40 && code <= 0x7e ? 0 : 2
    } else {
      result += character
    }
  }
  return result
}

export function normalizeFailureOutput(value: string): string {
  const withoutAnsi = stripAnsi(value)
  const lines = withoutAnsi
    .split(/\r?\n/u)
    .map((line) => line.trim())
  const testLine = lines.find((line) =>
    line.includes("›") && /\.(?:spec|test)\.[cm]?[jt]sx?:\d+/u.test(line))
  const prefixes = ["Error: ", "Locator:", "Expected:", "Received:"]
  const diagnosticLines = prefixes
    .map((prefix) => lines.find((line) => line.startsWith(prefix)))
    .filter((line) => line !== undefined)
  const selected = testLine ? [testLine, ...diagnosticLines] : diagnosticLines
  if (selected.length === 0) {
    return "playwright-exit-failure"
  }
  return selected
    .join("\n")
    .replace(/\b\d+(?:\.\d+)?(?:ms|s)\b/gu, "<duration>")
    .replace(/:\d+:\d+\b/gu, ":<line>")
}

export function createPlaywrightExecutor(
  projectRoot: string,
  selector: string,
  options: ExecutorOptions = {},
): TrialExecutor {
  const playwrightCliPath = resolvePlaywrightCliPath(projectRoot)
  return async (trial) => {
    const startedAt = Date.now()
    if (options.signal?.aborted) {
      return {
        status: "error",
        durationMs: 0,
        exitCode: null,
        failureSignature: fingerprint("diagnostic aborted"),
      }
    }
    const child = spawn(
      process.execPath,
      [playwrightCliPath, "test", selector, "--workers=1", "--reporter=line"],
      {
        cwd: projectRoot,
        shell: false,
        env: createTrialEnvironment(trial),
        windowsHide: true,
      },
    )

    return new Promise((resolve) => {
      let diagnostic = ""
      let settled = false
      const settle = (outcome: TrialOutcome): void => {
        if (settled) {
          return
        }
        settled = true
        options.signal?.removeEventListener("abort", abort)
        resolve(outcome)
      }
      const abort = (): void => {
        child.kill()
      }

      options.signal?.addEventListener("abort", abort, { once: true })
      child.stdout.on("data", (chunk: Buffer) => {
        diagnostic = appendBounded(diagnostic, chunk)
      })
      child.stderr.on("data", (chunk: Buffer) => {
        diagnostic = appendBounded(diagnostic, chunk)
      })
      child.on("error", (error) => {
        const failureReason = normalizeFailureOutput(error.message)
        settle({
          status: "error",
          durationMs: Date.now() - startedAt,
          exitCode: null,
          failureSignature: fingerprint(failureReason),
          failureReason,
        })
      })
      child.on("close", (exitCode) => {
        const aborted = options.signal?.aborted === true
        let status: TrialOutcome["status"] = exitCode === 0 ? "passed" : "failed"
        if (aborted) {
          status = "error"
        }
        const failureReason = normalizeFailureOutput(
          aborted ? "Error: diagnostic aborted" : diagnostic,
        )
        settle({
          status,
          durationMs: Date.now() - startedAt,
          exitCode,
          ...(exitCode === 0 && !aborted
            ? {}
            : {
                failureSignature: fingerprint(
                  failureReason,
                ),
                failureReason,
              }),
        })
      })
    })
  }
}

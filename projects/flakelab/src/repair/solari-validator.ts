import type { Sandbox } from "@solarisdk/sandbox"
import { SandboxClient } from "@solarisdk/sandbox"
import { readdir, readFile } from "node:fs/promises"
import { join, posix, relative, resolve, sep } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import type { ExperimentResult } from "../discovery/evaluate.js"
import { experimentResultSchema } from "../investigator/schema.js"
import type { Reproducer } from "../reproducer/schema.js"
import { retryTransient } from "../solari/retry.js"

const REMOTE_ROOT = "/work/flakelab"
const REMOTE_SETUP_ROOT = "/work/flakelab/.flakelab/setup"
const SANDBOX_TIMEOUT_MS = 15 * 60_000
const COMMAND_TIMEOUT_MS = 10 * 60_000
const UPLOAD_BATCH_SIZE = 8
const SETUP_POLL_ATTEMPTS = 300

interface RemoteValidationOptions {
  apiKey: string
  baseUrl: string
  concurrency: number
  regressionSelectors: string[]
  reproducer: Reproducer
  signal?: AbortSignal
  workspaceRoot: string
}

export interface RemoteValidationResult {
  afterControl: ExperimentResult
  afterHostile: ExperimentResult
  lint: boolean
  lintDiagnostic?: string
  regressions: { selector: string; result: ExperimentResult }[]
  typecheck: boolean
  typecheckDiagnostic?: string
}

interface ProjectFile {
  localPath: string
  remotePath: string
}

async function listProjectFiles(root: string, directory = root): Promise<ProjectFile[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: ProjectFile[] = []
  for (const entry of entries) {
    const localPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await listProjectFiles(root, localPath))
    } else if (entry.isFile()) {
      const projectPath = relative(root, localPath).split(sep).join(posix.sep)
      files.push({ localPath, remotePath: posix.join(REMOTE_ROOT, projectPath) })
    }
  }
  return files
}

async function uploadProject(sandbox: Sandbox, workspaceRoot: string): Promise<void> {
  const files = await listProjectFiles(workspaceRoot)
  const directories = [...new Set(files.map((file) => posix.dirname(file.remotePath)))]
  const mkdir = await sandbox.commands.run("mkdir", { args: ["-p", ...directories] })
  if (mkdir.exitCode !== 0) {
    throw new Error("Solari could not prepare the isolated project directory")
  }
  for (let index = 0; index < files.length; index += UPLOAD_BATCH_SIZE) {
    const batch = files.slice(index, index + UPLOAD_BATCH_SIZE)
    await Promise.all(batch.map(async (file) => {
      const content = await readFile(file.localPath)
      await sandbox.files.write(file.remotePath, content)
    }))
  }
}

async function runCommand(
  sandbox: Sandbox,
  command: string,
  args: string[],
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const result = await sandbox.commands.run(command, {
        args,
        cwd: REMOTE_ROOT,
        timeoutMs: COMMAND_TIMEOUT_MS,
      })
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Solari command failed"
      const reconnectable = /control channel closed|connection/iu.test(message)
      if (!reconnectable || attempt === 2) {
        throw error
      }
      await sandbox.reconnect()
    }
  }
  throw new Error("Solari command retry budget exhausted")
}

function safeDiagnostic(stdout: string, stderr: string): string {
  const redacted = `${stdout}\n${stderr}`.split(" ").map((token) => {
    const schemeEnd = token.indexOf("://")
    const credentialEnd = token.indexOf("@", schemeEnd + 3)
    if (schemeEnd < 0 || credentialEnd < 0) {
      return token
    }
    return `${token.slice(0, schemeEnd + 3)}<redacted>${token.slice(credentialEnd)}`
  }).join(" ")
  return redacted
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-12)
    .join(" | ")
    .slice(0, 2_000)
}

async function requireCommand(
  sandbox: Sandbox,
  command: string,
  label: string,
  args: string[],
): Promise<void> {
  const result = await runCommand(sandbox, command, args)
  if (result.exitCode !== 0) {
    const diagnostic = safeDiagnostic(result.stdout, result.stderr)
    throw new Error(
      `Solari ${label} failed with exit code ${result.exitCode}`
      + (diagnostic ? `: ${diagnostic}` : ""),
    )
  }
}

async function runDetachedSetup(
  sandbox: Sandbox,
  label: string,
  script: string,
  statusPath: string,
  signal?: AbortSignal,
): Promise<void> {
  await runCommand(sandbox, "rm", ["-f", statusPath])
  const started = await sandbox.commands.run("sh", {
    args: ["-c", script],
    background: true,
    cwd: REMOTE_ROOT,
  })
  if (started.exitCode !== 0) {
    throw new Error(`Solari could not start ${label}`)
  }
  for (let attempt = 1; attempt <= SETUP_POLL_ATTEMPTS; attempt += 1) {
    signal?.throwIfAborted()
    try {
      const status = await sandbox.files.readText(statusPath)
      const exitCode = Number(status.trim())
      if (exitCode !== 0) {
        throw new Error(`Solari ${label} failed with exit code ${exitCode}`)
      }
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : ""
      if (/control channel closed|connection/iu.test(message)) {
        await sandbox.reconnect()
      } else if (!/enoent|not found|no such file/iu.test(message)) {
        throw error
      }
    }
    await delay(1_000, undefined, { signal })
  }
  throw new Error(`Solari ${label} exceeded its timeout`)
}

function proofArguments(
  options: RemoteValidationOptions,
  selector: string,
  trials: number,
  hostile: boolean,
): string[] {
  const fault = options.reproducer.faults[0]
  return [
    "exec",
    "tsx",
    "src/repair/remote-proof-runner.ts",
    "--selector",
    selector,
    "--trials",
    String(trials),
    "--concurrency",
    String(options.concurrency),
    "--seed",
    String(options.reproducer.seed),
    "--min-rate",
    String(options.reproducer.expectedFailure.minimumRate),
    "--delay-ms",
    String(fault.delayMs),
    "--pattern",
    fault.pattern,
    ...(hostile ? ["--hostile"] : []),
  ]
}

async function runExperiment(
  sandbox: Sandbox,
  options: RemoteValidationOptions,
  selector: string,
  trials: number,
  hostile: boolean,
): Promise<ExperimentResult> {
  const result = await runCommand(sandbox, "pnpm", proofArguments(
    options,
    selector,
    trials,
    hostile,
  ))
  if (result.exitCode !== 0) {
    throw new Error(`Solari proof runner failed with exit code ${result.exitCode}`)
  }
  const output = result.stdout.trim().split(/\r?\n/u).at(-1)
  if (!output) {
    throw new Error("Solari proof runner returned no result")
  }
  return experimentResultSchema.parse(JSON.parse(output))
}

async function validateInSandbox(
  sandbox: Sandbox,
  options: RemoteValidationOptions,
): Promise<RemoteValidationResult> {
  await sandbox.connect()
  await uploadProject(sandbox, resolve(options.workspaceRoot))
  await runCommand(sandbox, "mkdir", ["-p", REMOTE_SETUP_ROOT])
  await requireCommand(sandbox, "npm", "Node.js bootstrap", [
    "install",
    "--global",
    "node@22.14.0",
  ])
  await requireCommand(sandbox, "npm", "pnpm bootstrap", [
    "install",
    "--global",
    "pnpm@11.6.0",
  ])
  await requireCommand(sandbox, "pnpm", "dependency installation", [
    "install",
    "--frozen-lockfile",
  ])
  options.signal?.throwIfAborted()
  const typecheckResult = await runCommand(sandbox, "pnpm", ["typecheck"])
  const lintResult = await runCommand(sandbox, "pnpm", ["lint"])
  const typecheck = typecheckResult.exitCode === 0
  const lint = lintResult.exitCode === 0
  await runDetachedSetup(
    sandbox,
    "browser system dependency installation",
    "pnpm exec playwright install-deps chromium >.flakelab/setup/browser-deps.log 2>&1; printf '%s' $? >.flakelab/setup/browser-deps.exit",
    `${REMOTE_SETUP_ROOT}/browser-deps.exit`,
    options.signal,
  )
  await runDetachedSetup(
    sandbox,
    "browser download",
    "pnpm exec playwright install chromium >.flakelab/setup/browser.log 2>&1; printf '%s' $? >.flakelab/setup/browser.exit",
    `${REMOTE_SETUP_ROOT}/browser.exit`,
    options.signal,
  )
  const afterHostile = await runExperiment(
    sandbox,
    options,
    options.reproducer.test,
    options.reproducer.trials,
    true,
  )
  const afterControl = await runExperiment(
    sandbox,
    options,
    options.reproducer.test,
    options.reproducer.trials,
    false,
  )
  const regressions = []
  for (const selector of options.regressionSelectors) {
    regressions.push({
      selector,
      result: await runExperiment(sandbox, options, selector, 2, false),
    })
  }
  return {
    afterControl,
    afterHostile,
    lint,
    ...(lint ? {} : {
      lintDiagnostic: safeDiagnostic(lintResult.stdout, lintResult.stderr),
    }),
    regressions,
    typecheck,
    ...(typecheck ? {} : {
      typecheckDiagnostic: safeDiagnostic(typecheckResult.stdout, typecheckResult.stderr),
    }),
  }
}

export async function validatePatchInSolari(
  options: RemoteValidationOptions,
): Promise<RemoteValidationResult> {
  options.signal?.throwIfAborted()
  const client = new SandboxClient({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    callTimeoutMs: COMMAND_TIMEOUT_MS,
  })
  const sandbox = await retryTransient(
    async () => client.create({
      template: "base",
      cpu: 4,
      memMb: 8_192,
      timeoutMs: SANDBOX_TIMEOUT_MS,
      lifecycle: { onTimeout: "kill" },
      metadata: { product: "flakelab", role: "patch-proof" },
    }),
    {
      attempts: 5,
      baseDelayMs: 500,
      signal: options.signal,
    },
  )
  try {
    return await validateInSandbox(sandbox, options)
  } finally {
    sandbox.close()
    await sandbox.kill()
  }
}

import type { Sandbox } from "@solarisdk/sandbox"
import { setTimeout as delay } from "node:timers/promises"

export const REMOTE_SETUP_ROOT = "/work/flakelab-setup"
const REMOTE_COMMAND_ROOT = "/work/flakelab-command"
const PREPARATION_COMMAND_TIMEOUT_MS = 2 * 60_000
const TRIAL_COMMAND_TIMEOUT_MS = 90_000
const SETUP_POLL_ATTEMPTS = 600

export class HistoricalIncompatibility extends Error {}

function labelForCommand(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-").replaceAll(/(^-|-$)/gu, "")
}

async function pollExitStatus(
  sandbox: Sandbox,
  statusPath: string,
  label: string,
  attempts: number,
  signal?: AbortSignal,
): Promise<number> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    signal?.throwIfAborted()
    try {
      const status = await sandbox.files.readText(statusPath)
      return Number(status.trim())
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
  throw new Error(`${label} exceeded its timeout`)
}

async function runCommand(
  sandbox: Sandbox,
  cwd: string,
  label: string,
  command: string,
  args: string[],
  timeoutMs = PREPARATION_COMMAND_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<number> {
  const statusPath = `${REMOTE_COMMAND_ROOT}/${labelForCommand(label)}.exit`
  const started = await sandbox.commands.run("sh", {
    args: [
      "-c",
      "status_path=$1; shift; mkdir -p \"$(dirname \"$status_path\")\"; "
      + "\"$@\" >\"${status_path%.exit}.log\" 2>&1; exit_code=$?; "
      + "printf '%s' \"$exit_code\" >\"$status_path\"",
      "flakelab-command",
      statusPath,
      command,
      ...args,
    ],
    background: true,
    cwd,
  })
  if (started.exitCode !== 0) {
    throw new Error(`Solari could not start ${command}`)
  }
  return pollExitStatus(
    sandbox,
    statusPath,
    `Solari ${command}`,
    Math.ceil(timeoutMs / 1_000),
    signal,
  )
}

export async function requireCommand(
  sandbox: Sandbox,
  cwd: string,
  label: string,
  command: string,
  args: string[],
): Promise<void> {
  const exitCode = await runCommand(sandbox, cwd, label, command, args)
  if (exitCode !== 0) {
    throw new HistoricalIncompatibility(`${label} failed with exit code ${exitCode}`)
  }
}

async function requireInfrastructureCommand(
  sandbox: Sandbox,
  label: string,
  command: string,
  args: string[],
): Promise<void> {
  const exitCode = await runCommand(sandbox, "/", label, command, args)
  if (exitCode !== 0) {
    throw new Error(`Solari ${label} failed with exit code ${exitCode}`)
  }
}

export async function runDetachedSetup(
  sandbox: Sandbox,
  script: string,
  signal?: AbortSignal,
): Promise<void> {
  await requireInfrastructureCommand(sandbox, "workspace preparation", "mkdir", [
    "-p",
    REMOTE_SETUP_ROOT,
  ])
  const statusPath = `${REMOTE_SETUP_ROOT}/bootstrap.exit`
  const started = await sandbox.commands.run("sh", {
    args: ["-c", script],
    background: true,
    cwd: "/",
  })
  if (started.exitCode !== 0) {
    throw new Error("Solari could not start the detached bisect bootstrap")
  }
  const exitCode = await pollExitStatus(
    sandbox,
    statusPath,
    "Solari bisect bootstrap",
    SETUP_POLL_ATTEMPTS,
    signal,
  )
  if (exitCode !== 0) {
    throw new Error(`Solari bisect bootstrap failed with exit code ${exitCode}`)
  }
}

export async function runDetachedTrial(
  sandbox: Sandbox,
  cwd: string,
  selector: string,
  environment: Record<string, string>,
  signal?: AbortSignal,
): Promise<number> {
  await sandbox.env(environment)
  return runCommand(
    sandbox,
    cwd,
    "bisect trial",
    "pnpm",
    [
      "exec",
      "playwright",
      "test",
      `./${selector}`,
      "--workers=1",
      "--reporter=line",
    ],
    TRIAL_COMMAND_TIMEOUT_MS,
    signal,
  )
}

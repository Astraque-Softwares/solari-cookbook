import type { Sandbox } from "@solarisdk/sandbox"
import { SandboxClient } from "@solarisdk/sandbox"
import { readdir, readFile } from "node:fs/promises"
import { join, posix, relative, resolve, sep } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { z } from "zod"

import type { ExperimentResult } from "../discovery/evaluate.js"
import { experimentResultSchema } from "../investigator/schema.js"
import type { Fault } from "../domain/schema.js"
import type { Reproducer } from "../reproducer/schema.js"
import { retryTransient } from "../solari/retry.js"
import { projectPlan } from "./project-plan.js"
import type { ProjectCommand } from "./project-plan.js"

const REMOTE_ROOT = "/work/flakelab"
const REMOTE_SETUP_ROOT = "/work/flakelab/.flakelab/setup"
const SANDBOX_TIMEOUT_MS = 15 * 60_000
const COMMAND_TIMEOUT_MS = 10 * 60_000
const PROOF_DISK_GB = 12
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
  projectDirectory?: string
}

export interface RemoteValidationResult {
  afterControl: ExperimentResult
  afterHostile: ExperimentResult
  lint: boolean | null
  lintDiagnostic?: string
  regressions: { selector: string; result: ExperimentResult }[]
  typecheck: boolean | null
  typecheckDiagnostic?: string
}

interface ProjectFile {
  localPath: string
  remotePath: string
}

const runtimeRoot = fileURLToPath(new URL("../../", import.meta.url))

async function prepareProject(sandbox: Sandbox, options: RemoteValidationOptions) {
  const plan = await projectPlan(options.workspaceRoot, options.projectDirectory ?? "")
  await preparePackageManager(sandbox, plan)
  const installed = await runCommand(sandbox, "env", [
    "YARN_NODE_LINKER=node-modules", plan.install.command, ...plan.install.args,
  ])
  if (installed.exitCode !== 0) {
    const diagnostic = safeDiagnostic(installed.stdout, installed.stderr)
    throw new Error(
      "Target dependency installation failed"
      + (diagnostic ? `: ${diagnostic}` : "; check its lockfile and registry requirements"),
    )
  }
  for (const command of plan.setup) {
    const result = await runProjectCheck(sandbox, command, plan.environment)
    if (result && result.exitCode !== 0) {
      const diagnostic = safeDiagnostic(result.stdout, result.stderr)
      throw new Error(
        `Proof setup script failed: ${command.args[1]}`
        + (diagnostic ? `: ${diagnostic}` : ""),
      )
    }
  }
  await prepareRuntime(sandbox)
  return plan
}

async function preparePackageManager(sandbox: Sandbox, plan: Awaited<ReturnType<typeof projectPlan>>) {
  await requireCommand(sandbox, "npm", "package manager bootstrap", [
    "install", "--global", plan.manager === "bun" ? (plan.version ?? "bun") : "corepack@0.34.0",
  ])
  if (plan.manager !== "bun") {
    await requireCommand(sandbox, "corepack", "package manager activation", ["enable"])
    if (plan.version && plan.manager !== "npm") {
      await requireCommand(sandbox, "corepack", "pinned package manager", ["prepare", plan.version, "--activate"])
    }
  }
  if (plan.manager === "npm" && plan.version) {
    await requireCommand(sandbox, "npm", "pinned npm", ["install", "--global", plan.version])
  }
}

async function prepareRuntime(sandbox: Sandbox) {
  await uploadProject(sandbox, resolve(runtimeRoot, "dist"), "/work/flakelab-runtime/dist")
  const manifest = z.object({
    dependencies: z.record(z.string(), z.string()),
    peerDependencies: z.record(z.string(), z.string()),
  }).parse(JSON.parse(await readFile(resolve(runtimeRoot, "package.json"), "utf8")))
  await sandbox.files.write("/work/flakelab-runtime/package.json", JSON.stringify({
    private: true, type: "module", dependencies: { ...manifest.dependencies, ...manifest.peerDependencies },
  }))
  const runtime = await runCommand(sandbox, "npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], "/work/flakelab-runtime")
  if (runtime.exitCode !== 0) throw new Error("Isolated FlakeLab runtime installation failed")
}

async function runProjectCheck(
  sandbox: Sandbox,
  command: ProjectCommand | undefined,
  environment: string[] = [],
) {
  if (!command) return undefined
  return environment.length > 0
    ? runCommand(
      sandbox,
      "env",
      [...environment, command.command, ...command.args],
      posix.join(REMOTE_ROOT, command.directory),
    )
    : runCommand(sandbox, command.command, command.args, posix.join(REMOTE_ROOT, command.directory))
}

function browserSetupScript(options: RemoteValidationOptions, action: string, label: string): string {
  const directory = posix.join(REMOTE_ROOT, options.projectDirectory ?? "")
  const script = `const {createRequire}=require('node:module');
const {execFileSync}=require('node:child_process');
const targetRequire=createRequire(${JSON.stringify(posix.join(directory, "package.json"))});
const cli=targetRequire.resolve('@playwright/test/cli');
execFileSync(process.execPath,[cli,${JSON.stringify(action)}],{stdio:'inherit'});`
  const encoded = Buffer.from(script).toString("base64")
  return `node -e 'eval(Buffer.from("${encoded}","base64").toString())' >.flakelab/setup/${label}.log 2>&1; printf '%s' $? >.flakelab/setup/${label}.exit`
}

export function remoteFaultArguments(faults: Fault[], hostile: boolean): string[] {
  return ["--faults-json", JSON.stringify(faults), ...(hostile ? ["--hostile"] : [])]
}

async function listProjectFiles(root: string, directory = root, remoteRoot = REMOTE_ROOT): Promise<ProjectFile[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: ProjectFile[] = []
  for (const entry of entries) {
    const localPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await listProjectFiles(root, localPath, remoteRoot))
    } else if (entry.isFile()) {
      const projectPath = relative(root, localPath).split(sep).join(posix.sep)
      files.push({ localPath, remotePath: posix.join(remoteRoot, projectPath) })
    }
  }
  return files
}

async function uploadProject(sandbox: Sandbox, workspaceRoot: string, remoteRoot = REMOTE_ROOT): Promise<void> {
  const files = await listProjectFiles(workspaceRoot, workspaceRoot, remoteRoot)
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
  cwd = REMOTE_ROOT,
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const result = await sandbox.commands.run(command, {
        args,
        cwd,
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
  return [
    "/work/flakelab-runtime/dist/repair/remote-proof-runner.js",
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
    ...remoteFaultArguments(options.reproducer.faults, hostile),
  ]
}

async function runExperiment(
  sandbox: Sandbox,
  options: RemoteValidationOptions,
  selector: string,
  trials: number,
  hostile: boolean,
  environment: string[],
): Promise<ExperimentResult> {
  const result = await runCommand(
    sandbox,
    "env",
    [...environment, "node", ...proofArguments(options, selector, trials, hostile)],
    posix.join(REMOTE_ROOT, options.projectDirectory ?? ""),
  )
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
  const project = await projectPlan(options.workspaceRoot, options.projectDirectory ?? "")
  await requireCommand(sandbox, "npm", "Node.js bootstrap", [
    "install",
    "--global",
    `node@${project.node}`,
  ])
  const plan = await prepareProject(sandbox, options)
  options.signal?.throwIfAborted()
  const typecheckResult = await runProjectCheck(sandbox, plan.typecheck, plan.environment)
  const lintResult = await runProjectCheck(sandbox, plan.lint, plan.environment)
  const typecheck = typecheckResult ? typecheckResult.exitCode === 0 : null
  const lint = lintResult ? lintResult.exitCode === 0 : null
  await runDetachedSetup(
    sandbox,
    "browser system dependency installation",
    browserSetupScript(options, "install-deps", "browser-deps"),
    `${REMOTE_SETUP_ROOT}/browser-deps.exit`,
    options.signal,
  )
  await runDetachedSetup(
    sandbox,
    "browser download",
    browserSetupScript(options, "install", "browser"),
    `${REMOTE_SETUP_ROOT}/browser.exit`,
    options.signal,
  )
  const afterHostile = await runExperiment(
    sandbox,
    options,
    options.reproducer.test,
    options.reproducer.trials,
    true,
    plan.environment,
  )
  const afterControl = await runExperiment(
    sandbox,
    options,
    options.reproducer.test,
    options.reproducer.trials,
    false,
    plan.environment,
  )
  const regressions = []
  for (const selector of options.regressionSelectors) {
    regressions.push({
      selector,
      result: await runExperiment(sandbox, options, selector, 2, false, plan.environment),
    })
  }
  return {
    afterControl,
    afterHostile,
    lint,
    ...(lint ? {} : {
      lintDiagnostic: lintResult ? safeDiagnostic(lintResult.stdout, lintResult.stderr) : "Not configured: no lint script",
    }),
    regressions,
    typecheck,
    ...(typecheck ? {} : {
      typecheckDiagnostic: typecheckResult ? safeDiagnostic(typecheckResult.stdout, typecheckResult.stderr) : "Not configured: no typecheck script",
    }),
  }
}

export async function validatePatchInSolari(
  options: RemoteValidationOptions,
): Promise<RemoteValidationResult> {
  options.signal?.throwIfAborted()
  const directory = options.projectDirectory ?? ""
  if (posix.isAbsolute(directory) || directory.split(/[\\/]/u).includes("..")) {
    throw new Error("Proof project directory must stay inside the uploaded workspace")
  }
  await projectPlan(options.workspaceRoot, directory)
  await readFile(resolve(runtimeRoot, "dist/repair/remote-proof-runner.js"))
  const client = new SandboxClient({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    callTimeoutMs: COMMAND_TIMEOUT_MS,
  })
  const sandbox = await retryTransient(
    async () => client.create({
      template: "base",
      cpu: 4,
      diskGb: PROOF_DISK_GB,
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

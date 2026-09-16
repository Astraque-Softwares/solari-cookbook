import { spawn } from "node:child_process"
import { access, readFile, symlink } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"

import ts from "typescript"

import type { RepositoryProfile } from "../project/schema.js"
import { repositoryEnvironment } from "../project/profile.js"
import { createPlaywrightEnvironment } from "../runner/playwright-executor.js"
import { waitForProcessTree } from "../runner/process-tree.js"
import { projectPlan, type ProjectCommand } from "./project-plan.js"
import type { CandidatePatch } from "./schema.js"
import { applyCandidatePatch, createPatchWorkspace } from "./workspace.js"

const COMMAND_TIMEOUT_MS = 10 * 60_000

export interface CandidatePreflight {
  lint: boolean | null
  testListed: boolean
  typecheck: boolean | null
}

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX
  if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs")) {
    return ts.ScriptKind.JS
  }
  return ts.ScriptKind.TS
}

async function validateSyntax(root: string, candidate: CandidatePatch): Promise<void> {
  for (const edit of candidate.edits) {
    const path = resolve(root, edit.path)
    const original = await readFile(path, "utf8")
    const source = original.replace(edit.before, edit.after)
    const kind = scriptKind(path)
    const usesJsx = kind === ts.ScriptKind.TSX || kind === ts.ScriptKind.JSX
    const diagnostics = ts.transpileModule(source, {
      compilerOptions: {
        ...(usesJsx ? { jsx: ts.JsxEmit.Preserve } : {}),
        target: ts.ScriptTarget.Latest,
      },
      fileName: path,
      reportDiagnostics: true,
    }).diagnostics ?? []
    if (diagnostics.length > 0) {
      const diagnostic = diagnostics[0]
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")
      throw new Error(`Candidate syntax is invalid in ${edit.path}: ${message}`)
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function linkDependencies(sourceRoot: string, targetRoot: string): Promise<void> {
  const source = resolve(sourceRoot, "node_modules")
  const target = resolve(targetRoot, "node_modules")
  if (await exists(source) && !await exists(target)) {
    await symlink(source, target, process.platform === "win32" ? "junction" : "dir")
  }
}

async function execute(
  command: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  environment: NodeJS.ProcessEnv = {},
): Promise<{ diagnostic: string; passed: boolean }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), COMMAND_TIMEOUT_MS)
  const abort = (): void => controller.abort()
  signal?.addEventListener("abort", abort, { once: true })
  try {
    const invocation = localInvocation(command, args)
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      detached: process.platform !== "win32",
      env: createPlaywrightEnvironment({ ...process.env, ...environment }),
      shell: false,
      signal: controller.signal,
      windowsHide: true,
    })
    const result = await waitForProcessTree(child, controller.signal)
    const diagnostic = result.spawnError ?? result.diagnostic
    return { diagnostic: diagnostic.slice(-2_000), passed: result.exitCode === 0 }
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener("abort", abort)
  }
}

function localInvocation(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== "win32") return { command, args }
  const nodeRoot = dirname(process.execPath)
  if (command === "npm") {
    return {
      command: process.execPath,
      args: [resolve(nodeRoot, "node_modules/npm/bin/npm-cli.js"), ...args],
    }
  }
  if (command === "pnpm" || command === "yarn") {
    return {
      command: process.execPath,
      args: [resolve(nodeRoot, "node_modules/corepack/dist/corepack.js"), command, ...args],
    }
  }
  return { command, args }
}

async function runCheck(
  root: string,
  command: ProjectCommand | undefined,
  signal?: AbortSignal,
  environment: NodeJS.ProcessEnv = {},
): Promise<boolean | null> {
  if (!command) return null
  const result = await execute(
    command.command,
    command.args,
    resolve(root, command.directory),
    signal,
    environment,
  )
  if (!result.passed) {
    throw new Error(`Candidate ${command.args.at(-1) ?? "check"} failed: ${result.diagnostic}`)
  }
  return true
}

async function listCandidateTest(
  profile: RepositoryProfile,
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<void> {
  const executionRoot = resolve(workspaceRoot, profile.projectDirectory)
  const configPath = resolve(
    workspaceRoot,
    relative(profile.workspaceRoot, profile.playwright.configPath),
  )
  const result = await execute(process.execPath, [
    profile.playwright.cliPath,
    "test",
    profile.playwright.target,
    "--config",
    configPath,
    "--list",
    "--reporter=json",
  ], executionRoot, signal, repositoryEnvironment(profile))
  if (!result.passed) throw new Error(`Candidate no longer lists the selected test: ${result.diagnostic}`)
}

export async function preflightCandidate(
  profile: RepositoryProfile,
  candidate: CandidatePatch,
  signal?: AbortSignal,
): Promise<CandidatePreflight> {
  await validateSyntax(profile.workspaceRoot, candidate)
  const workspace = await createPatchWorkspace(profile.executionRoot)
  try {
    await applyCandidatePatch(workspace.uploadRoot, candidate)
    await linkDependencies(profile.workspaceRoot, workspace.uploadRoot)
    if (profile.executionRoot !== profile.workspaceRoot) {
      await linkDependencies(profile.executionRoot, workspace.root)
    }
    const plan = await projectPlan(workspace.uploadRoot, workspace.projectDirectory)
    const environment = Object.fromEntries(plan.environment.map((entry) => {
      const split = entry.indexOf("=")
      return [entry.slice(0, split), entry.slice(split + 1)]
    }))
    const typecheck = await runCheck(workspace.uploadRoot, plan.typecheck, signal, environment)
    const lint = await runCheck(workspace.uploadRoot, plan.lint, signal, environment)
    await listCandidateTest(profile, workspace.uploadRoot, signal)
    return { lint, testListed: true, typecheck }
  } finally {
    await workspace.cleanup()
  }
}

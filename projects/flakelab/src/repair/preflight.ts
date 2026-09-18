import { spawn } from "node:child_process"
import { access, readFile, symlink } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"

import ts from "typescript"

import type { RepositoryProfile } from "../project/schema.js"
import { repositoryEnvironment } from "../project/profile.js"
import { createPlaywrightEnvironment } from "../runner/playwright-executor.js"
import { waitForProcessTree } from "../runner/process-tree.js"
import { projectPlan, type ProjectCommand } from "./project-plan.js"
import { CandidateValidationError } from "./rejection.js"
import type { CandidatePatch } from "./schema.js"
import { applyCandidatePatch, createPatchWorkspace } from "./workspace.js"

const COMMAND_TIMEOUT_MS = 10 * 60_000

export interface CandidatePreflight {
  lint: boolean | null
  testListed: boolean
  typecheck: boolean | null
}

interface CheckResult {
  diagnostic: string
  passed: boolean
}

const CHECK_DIAGNOSTIC_LIMIT = 50_000

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
      throw new CandidateValidationError(
        "syntax-invalid",
        `Candidate syntax is invalid in ${edit.path}: ${message}`,
        edit.path,
      )
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
): Promise<CheckResult> {
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
    return {
      diagnostic: diagnostic.slice(-CHECK_DIAGNOSTIC_LIMIT),
      passed: result.exitCode === 0,
    }
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
): Promise<CheckResult | null> {
  if (!command) return null
  return execute(
    command.command,
    command.args,
    resolve(root, command.directory),
    signal,
    environment,
  )
}

function diagnosticSignatures(diagnostic: string): Set<string> {
  const lines = diagnostic
    .replaceAll("\u001B", "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !isVolatileCheckProgress(line))
  const structured = lines.filter((line) =>
    /\berror TS\d+:/u.test(line)
    || /^\d+:\d+\s+(?:error|warning)\s+/u.test(line))
  const selected = structured.length > 0 ? structured : lines
  return new Set(selected.map((line) => line
    .replace(/\(\d+,\d+\)/gu, "(<line>,<column>)")
    .replace(/^\d+:\d+/u, "<line>:<column>")))
}

function isVolatileCheckProgress(line: string): boolean {
  return /\.[A-Za-z0-9]+ \(\d+(?:\.\d+)?ms\)$/u.test(line)
    || /^Finished in \d+(?:\.\d+)?ms on \d+ files using \d+ threads\.?$/u.test(line)
}

export function newCandidateDiagnostics(
  baseline: CheckResult,
  candidate: CheckResult,
): string[] {
  if (candidate.passed) return []
  if (baseline.passed) {
    const candidateDiagnostics = [...diagnosticSignatures(candidate.diagnostic)]
    return candidateDiagnostics.length > 0
      ? candidateDiagnostics
      : ["check changed from passing to failing without a diagnostic"]
  }
  const known = diagnosticSignatures(baseline.diagnostic)
  return [...diagnosticSignatures(candidate.diagnostic)].filter((line) => !known.has(line))
}

function validateCheck(
  command: ProjectCommand | undefined,
  baseline: CheckResult | null,
  candidate: CheckResult | null,
  code: "lint-new-diagnostic" | "typecheck-new-diagnostic",
): boolean | null {
  if (!command || !baseline || !candidate) return null
  const introduced = newCandidateDiagnostics(baseline, candidate)
  if (introduced.length > 0) {
    const label = command.args.at(-1) ?? "check"
    throw new CandidateValidationError(
      code,
      `Candidate ${label} introduced new errors: ${introduced.join("\n")}`,
    )
  }
  return true
}

function reverseCandidate(candidate: CandidatePatch): CandidatePatch {
  return {
    ...candidate,
    edits: candidate.edits.map((edit) => ({
      ...edit,
      after: edit.before,
      before: edit.after,
    })),
  }
}

async function validateCandidateCheck(
  root: string,
  command: ProjectCommand | undefined,
  candidate: CandidatePatch,
  code: "lint-new-diagnostic" | "typecheck-new-diagnostic",
  signal?: AbortSignal,
  environment: NodeJS.ProcessEnv = {},
): Promise<boolean | null> {
  const candidateResult = await runCheck(root, command, signal, environment)
  if (!command || !candidateResult) return null
  if (candidateResult.passed) return true
  await applyCandidatePatch(root, reverseCandidate(candidate))
  try {
    const baselineResult = await runCheck(root, command, signal, environment)
    return validateCheck(command, baselineResult, candidateResult, code)
  } finally {
    await applyCandidatePatch(root, candidate)
  }
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
  if (!result.passed) {
    throw new CandidateValidationError(
      "selected-test-not-listed",
      `Candidate no longer lists the selected test: ${result.diagnostic}`,
    )
  }
}

export async function preflightCandidate(
  profile: RepositoryProfile,
  candidate: CandidatePatch,
  signal?: AbortSignal,
): Promise<CandidatePreflight> {
  await validateSyntax(profile.workspaceRoot, candidate)
  const workspace = await createPatchWorkspace(profile.executionRoot)
  try {
    await linkDependencies(profile.workspaceRoot, workspace.uploadRoot)
    if (profile.executionRoot !== profile.workspaceRoot) {
      await linkDependencies(profile.executionRoot, workspace.root)
    }
    const plan = await projectPlan(workspace.uploadRoot, workspace.projectDirectory)
    const environment = Object.fromEntries(plan.environment.map((entry) => {
      const split = entry.indexOf("=")
      return [entry.slice(0, split), entry.slice(split + 1)]
    }))
    await applyCandidatePatch(workspace.uploadRoot, candidate)
    const typecheck = await validateCandidateCheck(
      workspace.uploadRoot,
      plan.typecheck,
      candidate,
      "typecheck-new-diagnostic",
      signal,
      environment,
    )
    const lint = await validateCandidateCheck(
      workspace.uploadRoot,
      plan.lint,
      candidate,
      "lint-new-diagnostic",
      signal,
      environment,
    )
    await listCandidateTest(profile, workspace.uploadRoot, signal)
    return { lint, testListed: true, typecheck }
  } finally {
    await workspace.cleanup()
  }
}

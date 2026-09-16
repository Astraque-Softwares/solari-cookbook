import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { createInterface } from "node:readline/promises"
import { promisify } from "node:util"

import { z } from "zod"

import { packageManager, workspaceRoot } from "../repair/project.js"
import {
  portableRepositoryProfileSchema,
  type PortableRepositoryProfile,
  type RepositoryProfile,
  type RepositoryTest,
} from "./schema.js"

const execute = promisify(execFile)
const CONFIG_NAMES = [
  "playwright.config.ts",
  "playwright.config.mts",
  "playwright.config.cts",
  "playwright.config.js",
  "playwright.config.mjs",
  "playwright.config.cjs",
]
const SELECTOR = /^(.*\.[cm]?[jt]sx?)(?::(\d+))?(?::(\d+))?$/iu
const PRIVATE_ENVIRONMENT = new Set(["GROQ_API_KEY", "SOLARI_API_KEY"])
const fingerprintInputs = new WeakMap<RepositoryProfile, string[]>()
const REPOSITORY_DRIFT_MESSAGE = "Repository inputs changed during the FlakeLab run"

const listedProjectSchema = z.object({
  name: z.string(),
  retries: z.number().int().nonnegative(),
})
const listedTestSchema = z.object({ projectName: z.string() })
const listedSpecSchema = z.object({
  column: z.number().int().nonnegative(),
  file: z.string(),
  line: z.number().int().nonnegative(),
  tests: z.array(listedTestSchema),
  title: z.string(),
})
interface ListedSuite {
  specs?: z.infer<typeof listedSpecSchema>[]
  suites?: ListedSuite[]
}
const listedSuiteSchema: z.ZodType<ListedSuite> = z.lazy(() => z.object({
  specs: z.array(listedSpecSchema).optional(),
  suites: z.array(listedSuiteSchema).optional(),
}))
const listReportSchema = z.object({
  config: z.object({
    projects: z.array(listedProjectSchema),
    rootDir: z.string(),
  }),
  errors: z.array(z.object({ message: z.string().optional() })).optional(),
  suites: z.array(listedSuiteSchema),
})

interface ParsedSelector {
  column?: number
  file: string
  line?: number
}

interface VerifiedConfig {
  configPath: string
  executionRoot: string
  playwrightCliPath: string
  retries: number
  score: number
  tests: RepositoryTest[]
}

function selectorSuffix(selector: ParsedSelector): string {
  const line = selector.line ? `:${selector.line}` : ""
  const column = selector.column ? `:${selector.column}` : ""
  return `${line}${column}`
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export function parseTestSelector(selector: string): ParsedSelector {
  const match = SELECTOR.exec(selector)
  if (!match) {
    throw new Error("Test target must be a JavaScript or TypeScript file, optionally followed by :line or :line:column")
  }
  return {
    file: match[1],
    ...(match[2] ? { line: Number(match[2]) } : {}),
    ...(match[3] ? { column: Number(match[3]) } : {}),
  }
}

function portable(root: string, path: string): string {
  const value = relative(root, path).replaceAll("\\", "/")
  if (value === "") return "."
  if (value === ".." || value.startsWith("../") || isAbsolute(value)) {
    throw new Error(`Repository path escapes the detected workspace: ${path}`)
  }
  return value
}

async function gitRoot(path: string): Promise<string | undefined> {
  try {
    const result = await execute("git", ["rev-parse", "--show-toplevel"], { cwd: path })
    return resolve(result.stdout.trim())
  } catch {
    return undefined
  }
}

async function candidateConfigs(
  testPath: string,
  boundary: string,
  explicitConfig?: string,
): Promise<string[]> {
  if (explicitConfig) {
    const path = resolve(explicitConfig)
    if (!await exists(path)) throw new Error(`Playwright config does not exist: ${explicitConfig}`)
    return [path]
  }
  const configs: string[] = []
  let directory = dirname(testPath)
  while (true) {
    for (const name of CONFIG_NAMES) {
      const path = resolve(directory, name)
      if (await exists(path)) configs.push(path)
    }
    if (directory === boundary || dirname(directory) === directory) break
    directory = dirname(directory)
  }
  return configs
}

async function packageRoot(start: string, boundary: string): Promise<string> {
  let directory = start
  while (true) {
    if (await exists(resolve(directory, "package.json"))) return directory
    if (directory === boundary || dirname(directory) === directory) return start
    directory = dirname(directory)
  }
}

function resolveProjectPlaywright(root: string): string {
  try {
    return createRequire(resolve(root, "package.json")).resolve("@playwright/test/cli")
  } catch (cause) {
    throw new Error(
      `Playwright is not installed for ${root}; install the repository dependencies before running FlakeLab`,
      { cause },
    )
  }
}

function collectSpecs(
  suites: ListedSuite[],
  rootDir: string,
  titles: string[] = [],
): RepositoryTest[] {
  const tests: RepositoryTest[] = []
  for (const suite of suites) {
    for (const spec of suite.specs ?? []) {
      tests.push({
        column: Math.max(1, spec.column),
        file: resolve(rootDir, spec.file),
        line: Math.max(1, spec.line),
        projects: [...new Set(spec.tests.map((test) => test.projectName || "default"))],
        title: [...titles, spec.title].filter(Boolean).join(" › "),
      })
    }
    tests.push(...collectSpecs(suite.suites ?? [], rootDir, titles))
  }
  return tests
}

function configScore(testPath: string, configPath: string): number {
  const path = relative(dirname(configPath), testPath)
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) return 10_000
  return path.split(sep).length
}

async function verifyConfig(configPath: string, selector: ParsedSelector, testPath: string, boundary: string): Promise<VerifiedConfig | undefined> {
  const executionRoot = await packageRoot(dirname(configPath), boundary)
  const playwrightCliPath = resolveProjectPlaywright(executionRoot)
  const targetPath = relative(executionRoot, testPath).replaceAll("\\", "/")
  const target = `${targetPath}${selectorSuffix(selector)}`
  try {
    const result = await execute(process.execPath, [
      playwrightCliPath,
      "test",
      target,
      "--config",
      configPath,
      "--list",
      "--reporter=json",
    ], {
      cwd: executionRoot,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !PRIVATE_ENVIRONMENT.has(name)),
      ),
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
      windowsHide: true,
    })
    const report = listReportSchema.parse(JSON.parse(result.stdout))
    const tests = collectSpecs(report.suites, report.config.rootDir)
      .filter((test) => resolve(test.file) === resolve(testPath))
    if (tests.length === 0 || (report.errors?.length ?? 0) > 0) return undefined
    return {
      configPath,
      executionRoot,
      playwrightCliPath,
      retries: Math.max(0, ...report.config.projects.map((project) => project.retries)),
      score: configScore(testPath, configPath),
      tests,
    }
  } catch {
    return undefined
  }
}

async function choose<T>(label: string, choices: T[], describe: (value: T) => string): Promise<T> {
  if (choices.length === 1) return choices[0]
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    const descriptions = choices.map(describe).join("\n")
    throw new Error(`${label} is ambiguous:\n${descriptions}\nRerun with a file:line selector or --config <path>.`)
  }
  const descriptions = choices.map((choice, index) => `${index + 1}. ${describe(choice)}`)
  process.stderr.write(`${label}:\n  ${descriptions.join("\n  ")}\n`)
  const prompt = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = Number(await prompt.question("Select a number: "))
    const selected = choices[answer - 1]
    if (!selected) throw new Error("Selection was not valid")
    return selected
  } finally {
    prompt.close()
  }
}

async function repositoryFingerprint(root: string, importantPaths: string[]): Promise<string> {
  const hash = createHash("sha256")
  const repository = await gitRoot(root)
  if (repository) {
    for (const args of [["rev-parse", "HEAD"], ["diff", "--binary", "HEAD"]]) {
      const result = await execute("git", args, { cwd: repository, maxBuffer: 32 * 1024 * 1024 })
      hash.update(result.stdout)
    }
    const status = await execute(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { cwd: repository, maxBuffer: 32 * 1024 * 1024 },
    )
    const relevantStatus = status.stdout.split("\0")
      .filter((entry) => entry && !/(?:^|[ /])\.flakelab\//u.test(entry.replaceAll("\\", "/")))
      .join("\0")
    hash.update(relevantStatus)
  }
  const sortedPaths = [...new Set(importantPaths)]
  sortedPaths.sort((left, right) => left.localeCompare(right))
  for (const path of sortedPaths) {
    hash.update(portable(root, path))
    hash.update(await readFile(path))
  }
  return hash.digest("hex")
}

async function taskRunner(root: string): Promise<RepositoryProfile["taskRunner"]> {
  if (await exists(resolve(root, "nx.json"))) return "nx"
  if (await exists(resolve(root, "turbo.json"))) return "turbo"
  return "package-scripts"
}

function lockfile(root: string): Promise<string | undefined> {
  const names = ["pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "package-lock.json"]
  return Promise.all(names.map(async (name) => await exists(resolve(root, name)) ? resolve(root, name) : undefined))
    .then((values) => values.find((value) => value !== undefined))
}

function discoveryBoundary(repositoryRoot: string | undefined, workspace: string): string {
  if (repositoryRoot && workspace.startsWith(repositoryRoot)) return repositoryRoot
  return workspace
}

function explicitConfig(invocationRoot: string, config: string | undefined): string | undefined {
  return config ? resolve(invocationRoot, config) : undefined
}

function directoryFromWorkspace(workspace: string, executionRoot: string): string {
  const directory = portable(workspace, executionRoot)
  return directory === "." ? "" : directory
}

export async function discoverRepositoryProfile(options: {
  artifactDirectory: string
  config?: string
  invocationRoot: string
  target: string
}): Promise<RepositoryProfile> {
  const invocationRoot = resolve(options.invocationRoot)
  const selector = parseTestSelector(options.target)
  const testPath = resolve(invocationRoot, selector.file)
  if (!await exists(testPath)) throw new Error(`Selected test does not exist: ${options.target}`)
  const repositoryRoot = await gitRoot(dirname(testPath))
  const workspace = await workspaceRoot(dirname(testPath))
  const boundary = discoveryBoundary(repositoryRoot, workspace)
  const configs = await candidateConfigs(
    testPath,
    boundary,
    explicitConfig(invocationRoot, options.config),
  )
  if (configs.length === 0) throw new Error("No Playwright configuration was found above the selected test")
  const verified = (await Promise.all(configs.map((config) =>
    verifyConfig(config, selector, testPath, boundary)))).filter((value) => value !== undefined)
  if (verified.length === 0) {
    throw new Error("No discovered Playwright configuration lists the selected test")
  }
  const bestScore = Math.min(...verified.map((candidate) => candidate.score))
  const selectedConfig = await choose(
    "Multiple Playwright configurations match the selected test",
    verified.filter((candidate) => candidate.score === bestScore),
    (candidate) => candidate.configPath,
  )
  const selectedTest = await choose(
    "Multiple Playwright tests match the selected file",
    selectedConfig.tests,
    (test) => `${relative(selectedConfig.executionRoot, test.file)}:${test.line} — ${test.title}`,
  )
  const installRoot = await workspaceRoot(selectedConfig.executionRoot)
  const selectedLockfile = await lockfile(installRoot)
  const importantPaths = [testPath, selectedConfig.configPath, resolve(selectedConfig.executionRoot, "package.json"), ...(selectedLockfile ? [selectedLockfile] : [])]
  for (const name of ["package.json", "pnpm-workspace.yaml", "nx.json", "turbo.json"] ) {
    const path = resolve(installRoot, name)
    if (await exists(path)) importantPaths.push(path)
  }
  const exactTarget = `${relative(selectedConfig.executionRoot, selectedTest.file).replaceAll("\\", "/")}:${selectedTest.line}`
  const profile: RepositoryProfile = {
    artifactRoot: invocationRoot,
    discoveredAt: new Date().toISOString(),
    executionRoot: selectedConfig.executionRoot,
    fingerprint: await repositoryFingerprint(installRoot, importantPaths),
    installRoot,
    invocationRoot,
    packageManager: await packageManager(installRoot),
    playwright: {
      cliPath: selectedConfig.playwrightCliPath,
      configPath: selectedConfig.configPath,
      configuredRetries: selectedConfig.retries,
      target: exactTarget,
      test: { ...selectedTest, file: exactTarget.replace(/:\d+$/u, "") },
    },
    projectDirectory: directoryFromWorkspace(installRoot, selectedConfig.executionRoot),
    reasons: [
      "The selected config lists the requested test through Playwright --list.",
      "Execution uses the nearest verified owning package.",
      "Installation uses the detected workspace root and lockfile.",
    ],
    sourceRoots: [installRoot],
    taskRunner: await taskRunner(installRoot),
    workspaceRoot: installRoot,
  }
  fingerprintInputs.set(profile, importantPaths)
  return profile
}

export function portableRepositoryProfile(profile: RepositoryProfile): PortableRepositoryProfile {
  return portableRepositoryProfileSchema.parse({
    artifactRoot: portable(profile.workspaceRoot, profile.artifactRoot),
    discoveredAt: profile.discoveredAt,
    executionDirectory: portable(profile.workspaceRoot, profile.executionRoot),
    fingerprint: profile.fingerprint,
    installDirectory: portable(profile.workspaceRoot, profile.installRoot),
    invocationDirectory: portable(profile.workspaceRoot, profile.invocationRoot),
    packageManager: profile.packageManager,
    playwright: {
      cli: portable(profile.workspaceRoot, profile.playwright.cliPath),
      config: portable(profile.workspaceRoot, profile.playwright.configPath),
      configuredRetries: profile.playwright.configuredRetries,
      target: profile.playwright.target,
      test: profile.playwright.test,
    },
    projectDirectory: profile.projectDirectory,
    reasons: profile.reasons,
    sourceDirectories: profile.sourceRoots.map((root) => portable(profile.workspaceRoot, root)),
    taskRunner: profile.taskRunner,
    workspaceDirectory: ".",
  })
}

export async function writeRepositoryProfile(profile: RepositoryProfile, directory: string): Promise<string> {
  const path = resolve(profile.artifactRoot, directory, "repository-profile.json")
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(portableRepositoryProfile(profile), null, 2)}\n`, "utf8")
  return path
}

export async function discoverAndWriteRepositoryProfile(options: {
  artifactDirectory: string
  config?: string
  invocationRoot: string
  target?: string
}): Promise<RepositoryProfile | undefined> {
  if (!options.target) return undefined
  const profile = await discoverRepositoryProfile({ ...options, target: options.target })
  await writeRepositoryProfile(profile, options.artifactDirectory)
  return profile
}

export async function assertRepositoryUnchanged(profile: RepositoryProfile): Promise<void> {
  const inputs = fingerprintInputs.get(profile)
  if (!inputs) throw new Error("Repository profile cannot be verified in this process")
  const fingerprint = await repositoryFingerprint(profile.workspaceRoot, inputs)
  if (fingerprint !== profile.fingerprint) {
    throw new Error(`${REPOSITORY_DRIFT_MESSAGE}; saved evidence is preserved, but provider work was stopped`)
  }
}

export function isRepositoryDriftError(error: Error): boolean {
  return error.message.includes(REPOSITORY_DRIFT_MESSAGE)
}

export function repositoryEnvironment(profile: RepositoryProfile): NodeJS.ProcessEnv {
  return profile.taskRunner === "nx" ? { NX_DAEMON: "false" } : {}
}

export async function approveRepositorySources(
  profile: RepositoryProfile,
  sourcePaths: string[],
): Promise<void> {
  const inputs = fingerprintInputs.get(profile)
  if (!inputs) throw new Error("Repository profile cannot approve source files in this process")
  const approved = [...new Set([...inputs, ...sourcePaths.map((path) => resolve(path))])]
  profile.fingerprint = await repositoryFingerprint(profile.workspaceRoot, approved)
  fingerprintInputs.set(profile, approved)
}

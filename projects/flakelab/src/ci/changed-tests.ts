import { execFile } from "node:child_process"
import { readdir } from "node:fs/promises"
import { join, posix, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const MAX_CHANGED_FILES = 500
const MAX_SELECTED_TESTS = 20
const TEST_PATTERN = /(?:^|\/)tests\/.+\.(?:spec|test)\.[cm]?[jt]sx?$/u
const BEHAVIOR_TEST_PATTERN = /^tests\/(?:e2e|fixtures)\/.+\.(?:spec|test)\.[cm]?[jt]sx?$/u

export interface ChangedTestSelection {
  changedFiles: string[]
  mode: "affected-suite" | "direct" | "none"
  tests: string[]
  truncated: boolean
}

function validateRevision(reference: string, label: string): void {
  if (!reference || reference.length > 200 || /[\r\n\0]/u.test(reference)) {
    throw new Error(`${label} must be a single Git revision no longer than 200 characters`)
  }
}

async function git(repositoryRoot: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  })
  return result.stdout
}

function projectFile(repositoryFile: string, projectPath: string): string | undefined {
  if (projectPath === "") {
    return repositoryFile
  }
  const prefix = `${projectPath}/`
  return repositoryFile.startsWith(prefix) ? repositoryFile.slice(prefix.length) : undefined
}

async function listFiles(root: string, directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await listFiles(root, path))
    } else if (entry.isFile()) {
      files.push(relative(root, path).split(sep).join(posix.sep))
    }
  }
  return files
}

async function behaviorTests(projectRoot: string): Promise<string[]> {
  const testRoot = join(projectRoot, "tests")
  try {
    return (await listFiles(projectRoot, testRoot))
      .filter((path) => BEHAVIOR_TEST_PATTERN.test(path))
      .sort((left, right) => left.localeCompare(right))
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : ""
    if (code === "ENOENT") {
      return []
    }
    throw error
  }
}

function affectsBehavior(path: string): boolean {
  return /^(?:src\/|tests\/support\/|playwright\.config\.|package\.json$|pnpm-lock\.yaml$)/u
    .test(path)
}

export async function selectChangedTests(
  projectRoot: string,
  baseRevision: string,
  headRevision: string,
): Promise<ChangedTestSelection> {
  validateRevision(baseRevision, "base revision")
  validateRevision(headRevision, "head revision")
  const repositoryRoot = resolve((await git(projectRoot, ["rev-parse", "--show-toplevel"])).trim())
  const relativeProject = relative(repositoryRoot, resolve(projectRoot)).split(sep).join(posix.sep)
  if (relativeProject.startsWith("..")) {
    throw new Error("project must remain inside its Git repository")
  }
  const output = await git(repositoryRoot, [
    "diff",
    "--name-only",
    "--diff-filter=ACMR",
    "-z",
    `${baseRevision}...${headRevision}`,
  ])
  const repositoryFiles = output.split("\0").filter(Boolean)
  if (repositoryFiles.length > MAX_CHANGED_FILES) {
    throw new Error(`change set exceeds the ${MAX_CHANGED_FILES}-file safety limit`)
  }
  const changedFiles = repositoryFiles
    .map((path) => projectFile(path, relativeProject))
    .filter((path) => path !== undefined)
    .sort((left, right) => left.localeCompare(right))
  const direct = changedFiles.filter((path) => TEST_PATTERN.test(path))
  let candidates: string[] = []
  let mode: ChangedTestSelection["mode"] = "none"
  if (direct.length > 0) {
    candidates = direct
    mode = "direct"
  } else if (changedFiles.some(affectsBehavior)) {
    candidates = await behaviorTests(projectRoot)
    mode = candidates.length > 0 ? "affected-suite" : "none"
  }
  return {
    changedFiles,
    mode,
    tests: candidates.slice(0, MAX_SELECTED_TESTS),
    truncated: candidates.length > MAX_SELECTED_TESTS,
  }
}

import { readFile, readdir, stat } from "node:fs/promises"
import type { Dirent } from "node:fs"
import { basename, dirname, extname, relative, resolve } from "node:path"

import { projectFiles } from "../repair/project.js"

const MAX_SOURCE_BYTES = 64 * 1_024
const MAX_APPROVED_SOURCE_BYTES = 256 * 1_024
const MAX_INVESTIGATION_CONTEXT_BYTES = 20 * 1_024
const MAX_REPAIR_CONTEXT_BYTES = 12 * 1_024
const MAX_CONTEXT_FILES = 8
const MAX_APPROVED_SOURCE_FILES = MAX_CONTEXT_FILES - 1
const MAX_DISCOVERY_TEST_FILES = 20
const MAX_RANKED_SOURCE_FILES = 7
const ALLOWED_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".ts", ".tsx"])
const SECRET_ASSIGNMENT = /(?:api[_-]?key|authorization|password|secret|token)\s*[:=]\s*["'][^"']{8,}/iu
const LOCAL_IMPORT = /\bfrom\s+["'](\.[^"']+)["']/gu
const TEST_FILE = /\.(?:spec|test)\.(?:js|jsx|mjs|ts|tsx)$/iu
const PLAYWRIGHT_LOCATION = /(\.(?:js|jsx|mjs|ts|tsx)):\d+(?::\d+)?$/iu

export interface SafeSource {
  content: string
  path: string
}

function resolveSafeSource(projectRoot: string, selector: string): string {
  const sourcePath = resolve(projectRoot, selector.replace(PLAYWRIGHT_LOCATION, "$1"))
  const pathFromRoot = relative(projectRoot, sourcePath)
  if (pathFromRoot.startsWith("..") || pathFromRoot.includes("node_modules")) {
    throw new Error("Test source must stay inside the project and outside dependencies")
  }
  if (!ALLOWED_EXTENSIONS.has(extname(sourcePath).toLowerCase())) {
    throw new Error("Only JavaScript or TypeScript test source can be inspected")
  }
  return sourcePath
}

function resolveSafeProjectPath(projectRoot: string, selector: string): string {
  const selectedPath = resolve(projectRoot, selector.replace(PLAYWRIGHT_LOCATION, "$1"))
  const pathFromRoot = relative(projectRoot, selectedPath)
  if (pathFromRoot.startsWith("..") || pathFromRoot.includes("node_modules")) {
    throw new Error("Test selection must stay inside the project and outside dependencies")
  }
  return selectedPath
}

export async function readSafeTestSource(
  projectRoot: string,
  selector: string,
): Promise<SafeSource> {
  const sourcePath = resolveSafeSource(projectRoot, selector)
  const sourceStats = await stat(sourcePath)
  if (!sourceStats.isFile() || sourceStats.size > MAX_SOURCE_BYTES) {
    throw new Error("Test source must be a regular file no larger than 64 KiB")
  }
  const content = await readFile(sourcePath, "utf8")
  if (SECRET_ASSIGNMENT.test(content)) {
    throw new Error("Test source contains a possible credential and cannot be sent to a model")
  }
  return { content, path: relative(projectRoot, sourcePath) }
}

async function existingSourcePath(importer: string, specifier: string): Promise<string | undefined> {
  const requested = resolve(dirname(importer), specifier)
  const extension = extname(requested)
  const base = extension ? requested.slice(0, -extension.length) : requested
  const candidates = extension === ".js"
    ? [`${base}.ts`, `${base}.tsx`, requested]
    : [requested, `${requested}.ts`, `${requested}.tsx`, resolve(requested, "index.ts")]
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) {
        return candidate
      }
    } catch {
      // Missing candidates are expected while resolving TypeScript's emitted .js imports.
    }
  }
  return undefined
}

function localImports(content: string): string[] {
  return [...content.matchAll(LOCAL_IMPORT)].map((match) => match[1])
}

async function readSafeContext(
  projectRoot: string,
  selectors: string[],
): Promise<SafeSource[]> {
  const queue = selectors.map((selector) => resolveSafeSource(projectRoot, selector))
  const visited = new Set<string>()
  const context: SafeSource[] = []
  while (queue.length > 0 && context.length < MAX_CONTEXT_FILES) {
    const sourcePath = queue.shift()
    if (!sourcePath || visited.has(sourcePath)) {
      continue
    }
    visited.add(sourcePath)
    const source = await readSafeTestSource(projectRoot, sourcePath)
    context.push(source)
    for (const specifier of localImports(source.content)) {
      const dependency = await existingSourcePath(sourcePath, specifier)
      if (dependency && !visited.has(dependency)) {
        queue.push(dependency)
      }
    }
  }
  const totalBytes = context.reduce((total, source) => total + Buffer.byteLength(source.content), 0)
  if (totalBytes > MAX_SOURCE_BYTES) {
    throw new Error("Local test context exceeds the 64 KiB model boundary")
  }
  return context
}

export function readSafeTestContext(projectRoot: string, selector: string): Promise<SafeSource[]> {
  return readSafeContext(projectRoot, [selector]).then((sources) => {
    let remainingBytes = MAX_INVESTIGATION_CONTEXT_BYTES
    return sources.filter((source, index) => {
      const sourceBytes = Buffer.byteLength(source.content)
      if (sourceBytes > remainingBytes && index > 0) {
        return false
      }
      remainingBytes -= sourceBytes
      return true
    })
  })
}

export function readSafeRepairContext(
  projectRoot: string,
  selectedTest: string,
  approvedSourcePaths: string[],
  relevanceText = "",
): Promise<SafeSource[]> {
  if (approvedSourcePaths.length > MAX_APPROVED_SOURCE_FILES) {
    throw new Error(
      `Repair accepts at most ${MAX_APPROVED_SOURCE_FILES} explicitly approved source files`,
    )
  }
  return readBoundedRepairContext(
    projectRoot,
    selectedTest,
    approvedSourcePaths,
    relevanceText,
  )
}

function relevanceWeights(value: string): Map<string, number> {
  const weights = new Map<string, number>()
  for (const match of value.toLowerCase().match(/[a-z0-9_-]{4,}/gu) ?? []) {
    weights.set(match, (weights.get(match) ?? 0) + 1)
  }
  return weights
}

function relevantSourceExcerpt(content: string, clue: string, maxBytes: number): string {
  if (Buffer.byteLength(content) <= maxBytes) {
    return content
  }
  const lines = content.split("\n")
  const weights = relevanceWeights(clue)
  const scores = lines.map((line) => {
    const normalized = line.toLowerCase()
    return [...weights].reduce(
      (score, [term, weight]) => score + (normalized.includes(term) ? weight : 0),
      0,
    )
  })
  const focus = scores.reduce(
    (best, score, index) => score > scores[best] ? index : best,
    0,
  )
  let start = focus
  let end = focus + 1
  let excerptBytes = Buffer.byteLength(lines[focus]) + 1
  while (start > 0 || end < lines.length) {
    const nextStart = start > 0 ? start - 1 : start
    const nextEnd = end < lines.length ? end + 1 : end
    const additions = [
      ...(nextStart < start ? [lines[nextStart]] : []),
      ...(nextEnd > end ? [lines[end]] : []),
    ]
    const addedBytes = additions.reduce((total, line) => total + Buffer.byteLength(line) + 1, 0)
    if (excerptBytes + addedBytes > maxBytes) {
      break
    }
    start = nextStart
    end = nextEnd
    excerptBytes += addedBytes
  }
  return lines.slice(start, end).join("\n")
}

async function readApprovedSource(
  projectRoot: string,
  selector: string,
  clue: string,
  maxContextBytes: number,
): Promise<SafeSource> {
  const sourcePath = resolveSafeSource(projectRoot, selector)
  const sourceStats = await stat(sourcePath)
  if (!sourceStats.isFile() || sourceStats.size > MAX_APPROVED_SOURCE_BYTES) {
    throw new Error("Approved source must be a regular file no larger than 256 KiB")
  }
  const content = await readFile(sourcePath, "utf8")
  if (SECRET_ASSIGNMENT.test(content)) {
    throw new Error("Approved source contains a possible credential and cannot be sent to a model")
  }
  return {
    content: relevantSourceExcerpt(content, clue, maxContextBytes),
    path: relative(projectRoot, sourcePath),
  }
}

async function readBoundedRepairContext(
  projectRoot: string,
  selectedTest: string,
  approvedSourcePaths: string[],
  relevanceText: string,
): Promise<SafeSource[]> {
  const testSource = await readSafeTestSource(projectRoot, selectedTest)
  const remainingBytes = MAX_REPAIR_CONTEXT_BYTES - Buffer.byteLength(testSource.content)
  if (remainingBytes <= 0) {
    throw new Error("Selected test exhausts the 12 KiB repair context boundary")
  }
  const bytesPerSource = Math.floor(remainingBytes / Math.max(approvedSourcePaths.length, 1))
  const approvedSources = await Promise.all(approvedSourcePaths.map((sourcePath) =>
    readApprovedSource(projectRoot, sourcePath, relevanceText, bytesPerSource)))
  return [testSource, ...approvedSources]
}

interface DirectoryContents {
  directories: string[]
  tests: string[]
}

function classifyDirectoryEntries(directory: string, entries: Dirent[]): DirectoryContents {
  const contents: DirectoryContents = { directories: [], tests: [] }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue
    }
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      contents.directories.push(path)
    } else if (entry.isFile() && TEST_FILE.test(entry.name)) {
      contents.tests.push(path)
    }
  }
  return contents
}

async function directoryContents(directory: string): Promise<DirectoryContents> {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name))
  return classifyDirectoryEntries(directory, entries)
}

async function testFilesUnder(directory: string): Promise<string[]> {
  const pending = [directory]
  const tests: string[] = []
  while (pending.length > 0 && tests.length < MAX_DISCOVERY_TEST_FILES) {
    const current = pending.shift()!
    const contents = await directoryContents(current)
    const available = MAX_DISCOVERY_TEST_FILES - tests.length
    pending.push(...contents.directories)
    tests.push(...contents.tests.slice(0, available))
  }
  return tests
}

async function selectedTestFiles(projectRoot: string, selector: string): Promise<string[]> {
  const selectedPath = resolveSafeProjectPath(projectRoot, selector)
  const details = await stat(selectedPath)
  if (details.isFile()) {
    return [resolveSafeSource(projectRoot, selectedPath)]
  }
  if (details.isDirectory()) {
    return testFilesUnder(selectedPath)
  }
  return []
}

export async function discoverRepairSourceCandidates(
  projectRoot: string,
  selector: string,
): Promise<string[]> {
  return (await discoverRankedRepairSourceCandidates(projectRoot, selector))
    .map((candidate) => candidate.path)
}

export interface RepairSourceCandidate {
  path: string
  reason: string
}

export async function discoverRankedRepairSourceCandidates(
  projectRoot: string,
  selector: string,
): Promise<RepairSourceCandidate[]> {
  const tests = await selectedTestFiles(projectRoot, selector)
  const selectedTests = new Set(tests.map((path) => relative(projectRoot, path)))
  const candidates = new Set<string>()
  for (const testPath of tests) {
    const context = await readSafeContext(projectRoot, [testPath])
    for (const source of context) {
      if (!selectedTests.has(source.path) && !TEST_FILE.test(source.path)) {
        candidates.add(source.path.replaceAll("\\", "/"))
      }
    }
  }
  const direct = [...candidates].sort((left, right) => left.localeCompare(right))
  if (direct.length > 0 && direct.some((path) => !isTestSupportPath(path))) {
    return direct.slice(0, MAX_RANKED_SOURCE_FILES).map((path) => ({
      path,
      reason: "Imported by the selected test or its local support graph.",
    }))
  }
  const ranked = await rankedApplicationSources(projectRoot, tests, selectedTests)
  const combined = [...new Set([...ranked, ...direct])].slice(0, MAX_RANKED_SOURCE_FILES)
  return combined.map((path) => ({
    path,
    reason: direct.includes(path)
      ? "Imported by the selected test or its local support graph."
      : "Matched route, component, or identifier clues from the selected test.",
  }))
}

function isTestSupportPath(path: string): boolean {
  const normalized = `/${path.replaceAll("\\", "/").toLowerCase()}/`
  return normalized.includes("/e2e/")
    || normalized.includes("/tests/")
    || normalized.includes("/fixtures/")
    || normalized.includes("/page-model")
}

const CLUE_STOP_WORDS = new Set([
  "async", "await", "const", "expect", "first", "locator", "page", "playwright",
  "should", "test", "timeout", "visible",
])

function sourceClues(content: string): string[] {
  const separated = content.replace(/([a-z])([A-Z])/gu, "$1 $2").toLowerCase()
  const clues = new Set<string>()
  for (const word of separated.match(/[a-z][a-z0-9-]{4,}/gu) ?? []) {
    if (CLUE_STOP_WORDS.has(word)) continue
    clues.add(word)
    if (word.endsWith("s") && word.length > 5) clues.add(word.slice(0, -1))
  }
  return [...clues]
}

function sourceScore(path: string, content: string, clues: string[]): number {
  const normalizedPath = path.toLowerCase()
  const name = basename(normalizedPath, extname(normalizedPath))
  const normalizedContent = content.toLowerCase()
  return clues.reduce((score, clue) => {
    if (name.includes(clue)) return score + 12
    if (normalizedPath.includes(clue)) return score + 6
    return normalizedContent.includes(clue) ? score + 1 : score
  }, 0)
}

async function selectedClues(tests: string[]): Promise<string[]> {
  const contents = await Promise.all(tests.map(async (path) => readFile(path, "utf8")))
  return sourceClues(contents.join("\n"))
}

function eligibleApplicationSource(path: string, selectedTests: Set<string>): boolean {
  const normalized = path.replaceAll("\\", "/")
  if (selectedTests.has(normalized) || TEST_FILE.test(normalized)) return false
  if (!ALLOWED_EXTENSIONS.has(extname(normalized).toLowerCase())) return false
  return !/(?:^|\/)(?:dist|build|coverage|generated|node_modules|\.flakelab)(?:\/|$)/u.test(normalized)
}

async function rankedApplicationSources(
  projectRoot: string,
  tests: string[],
  selectedTests: Set<string>,
): Promise<string[]> {
  const clues = await selectedClues(tests)
  const scored: Array<{ path: string; score: number }> = []
  for (const path of await projectFiles(projectRoot)) {
    const normalized = path.replaceAll("\\", "/")
    if (!eligibleApplicationSource(normalized, selectedTests)) continue
    try {
      const details = await stat(resolve(projectRoot, path))
      if (!details.isFile() || details.size > MAX_APPROVED_SOURCE_BYTES) continue
      const content = await readFile(resolve(projectRoot, path), "utf8")
      const score = sourceScore(normalized, content, clues)
      if (score > 0) scored.push({ path: normalized, score })
    } catch {
      // The inventory may change while suggestions are ranked; missing files are ignored.
    }
  }
  const ranked = [...scored]
  ranked.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
  return ranked
    .slice(0, MAX_RANKED_SOURCE_FILES)
    .map((entry) => entry.path)
}

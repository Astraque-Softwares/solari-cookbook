import { readFile, stat } from "node:fs/promises"
import { dirname, extname, relative, resolve } from "node:path"

const MAX_SOURCE_BYTES = 64 * 1_024
const MAX_CONTEXT_FILES = 8
const ALLOWED_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".ts", ".tsx"])
const SECRET_ASSIGNMENT = /(?:api[_-]?key|authorization|password|secret|token)\s*[:=]\s*["'][^"']{8,}/iu
const LOCAL_IMPORT = /\bfrom\s+["'](\.[^"']+)["']/gu

export interface SafeSource {
  content: string
  path: string
}

function resolveSafeSource(projectRoot: string, selector: string): string {
  const sourcePath = resolve(projectRoot, selector)
  const pathFromRoot = relative(projectRoot, sourcePath)
  if (pathFromRoot.startsWith("..") || pathFromRoot.includes("node_modules")) {
    throw new Error("Test source must stay inside the project and outside dependencies")
  }
  if (!ALLOWED_EXTENSIONS.has(extname(sourcePath).toLowerCase())) {
    throw new Error("Only JavaScript or TypeScript test source can be inspected")
  }
  return sourcePath
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

export async function readSafeTestContext(
  projectRoot: string,
  selector: string,
): Promise<SafeSource[]> {
  const rootPath = resolveSafeSource(projectRoot, selector)
  const queue = [rootPath]
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

import { readFile } from "node:fs/promises"
import { extname, relative, resolve } from "node:path"

import type { CandidatePatch } from "./schema.js"
import { candidatePatchSchema } from "./schema.js"

const ALLOWED_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".ts", ".tsx"])
const FORBIDDEN_ADDITIONS = [
  "test.skip",
  "test.fixme",
  "test.only",
  "expect.soft",
  "eslint-disable",
  "@ts-ignore",
  "@ts-expect-error",
]
const SECRET_ASSIGNMENT = /(?:api[_-]?key|authorization|password|secret|token)\s*[:=]\s*["'][^"']{8,}/iu

function normalizedRelativePath(projectRoot: string, requestedPath: string): string {
  const absolutePath = resolve(projectRoot, requestedPath)
  const pathFromRoot = relative(projectRoot, absolutePath).replaceAll("\\", "/")
  if (pathFromRoot.startsWith("..") || pathFromRoot.includes("node_modules")) {
    throw new Error("Candidate edits must stay inside project source")
  }
  if (!ALLOWED_EXTENSIONS.has(extname(absolutePath).toLowerCase())) {
    throw new Error("Candidate edits are limited to JavaScript and TypeScript source")
  }
  return pathFromRoot
}

function occurrences(content: string, snippet: string): number {
  let count = 0
  let index = content.indexOf(snippet)
  while (index >= 0) {
    count += 1
    index = content.indexOf(snippet, index + snippet.length)
  }
  return count
}

function onlyRaisesNumericLimits(before: string, after: string): boolean {
  const beforeNumbers = [...before.matchAll(/\d+/gu)].map((match) => Number(match[0]))
  const afterNumbers = [...after.matchAll(/\d+/gu)].map((match) => Number(match[0]))
  const sameStructure = before.replaceAll(/\d+/gu, "<number>")
    === after.replaceAll(/\d+/gu, "<number>")
  return sameStructure
    && beforeNumbers.length > 0
    && beforeNumbers.length === afterNumbers.length
    && afterNumbers.some((value, index) => value > beforeNumbers[index])
}

export async function validateCandidatePatch(
  projectRoot: string,
  selectedTest: string,
  allowedSourcePaths: string[],
  value: CandidatePatch,
): Promise<CandidatePatch> {
  const candidate = candidatePatchSchema.parse(value)
  const normalizedTest = normalizedRelativePath(projectRoot, selectedTest)
  const allowed = new Set(allowedSourcePaths.map((path) => normalizedRelativePath(projectRoot, path)))
  for (const edit of candidate.edits) {
    const path = normalizedRelativePath(projectRoot, edit.path)
    if (path === normalizedTest || !allowed.has(path)) {
      throw new Error(`Candidate cannot edit unapproved source: ${path}`)
    }
    if (FORBIDDEN_ADDITIONS.some((token) => edit.after.includes(token) && !edit.before.includes(token))) {
      throw new Error(`Candidate introduces a forbidden test-weakening construct in ${path}`)
    }
    if (SECRET_ASSIGNMENT.test(edit.after)) {
      throw new Error(`Candidate introduces a possible credential in ${path}`)
    }
    if (onlyRaisesNumericLimits(edit.before, edit.after)) {
      throw new Error(`Candidate only raises a numeric timing limit in ${path}`)
    }
    const content = await readFile(resolve(projectRoot, path), "utf8")
    if (occurrences(content, edit.before) !== 1) {
      throw new Error(`Candidate edit must match exactly one source location in ${path}`)
    }
  }
  return candidate
}

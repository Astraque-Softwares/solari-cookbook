import { readFile } from "node:fs/promises"
import { extname, isAbsolute, relative, resolve } from "node:path"

import type { CandidatePatch } from "./schema.js"
import { candidatePatchSchema } from "./schema.js"
import { CandidateValidationError } from "./rejection.js"

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
const PLAYWRIGHT_LOCATION = /(\.(?:js|jsx|mjs|ts|tsx)):\d+(?::\d+)?$/iu

function normalizedRelativePath(projectRoot: string, requestedPath: string): string {
  const absolutePath = resolve(projectRoot, requestedPath.replace(PLAYWRIGHT_LOCATION, "$1"))
  const pathFromRoot = relative(projectRoot, absolutePath).replaceAll("\\", "/")
  if (pathFromRoot === ".." || pathFromRoot.startsWith("../") || isAbsolute(pathFromRoot)
    || pathFromRoot.split("/").includes("node_modules")) {
    throw new CandidateValidationError(
      "unsafe-path",
      "Candidate edits must stay inside project source",
    )
  }
  if (!ALLOWED_EXTENSIONS.has(extname(absolutePath).toLowerCase())) {
    throw new CandidateValidationError(
      "unsafe-path",
      "Candidate edits are limited to JavaScript and TypeScript source",
    )
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

function matchSourceLineEndings(snippet: string, source: string): string {
  const lineEnding = source.includes("\r\n") ? "\r\n" : "\n"
  return snippet.replaceAll(/\r\n|\r|\n/gu, lineEnding)
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

function parseCandidate(value: CandidatePatch): CandidatePatch {
  const parsed = candidatePatchSchema.safeParse(value)
  if (parsed.success) return parsed.data
  const sizeLimit = parsed.error.issues.some((issue) => issue.code === "too_big")
  throw new CandidateValidationError(
    sizeLimit ? "size-limit" : "schema-invalid",
    sizeLimit
      ? "Candidate exceeds the bounded patch size limit"
      : "Candidate does not match the required patch schema",
  )
}

export async function validateCandidateSafety(
  projectRoot: string,
  selectedTest: string,
  allowedSourcePaths: string[],
  value: CandidatePatch,
): Promise<CandidatePatch> {
  const candidate = parseCandidate(value)
  const normalizedTest = normalizedRelativePath(projectRoot, selectedTest)
  const allowed = new Set(allowedSourcePaths.map((path) => normalizedRelativePath(projectRoot, path)))
  const normalizedEdits: CandidatePatch["edits"] = []
  for (const edit of candidate.edits) {
    const path = normalizedRelativePath(projectRoot, edit.path)
    if (path === normalizedTest || !allowed.has(path)) {
      throw new CandidateValidationError(
        "unapproved-source",
        `Candidate cannot edit unapproved source: ${path}`,
        path,
      )
    }
    if (SECRET_ASSIGNMENT.test(edit.after)) {
      throw new CandidateValidationError(
        "possible-secret",
        `Candidate introduces a possible credential in ${path}`,
        path,
      )
    }
    const content = await readFile(resolve(projectRoot, path), "utf8")
    const before = matchSourceLineEndings(edit.before, content)
    const after = matchSourceLineEndings(edit.after, content)
    if (occurrences(content, before) !== 1) {
      throw new CandidateValidationError(
        "exact-before-mismatch",
        `Candidate edit must match exactly one source location in ${path}`,
        path,
      )
    }
    normalizedEdits.push({ ...edit, after, before })
  }
  return { ...candidate, edits: normalizedEdits }
}

export function validateCandidateSemantics(candidate: CandidatePatch): CandidatePatch {
  for (const edit of candidate.edits) {
    if (FORBIDDEN_ADDITIONS.some((token) =>
      edit.after.includes(token) && !edit.before.includes(token))) {
      throw new CandidateValidationError(
        "test-weakening",
        `Candidate introduces a forbidden test-weakening construct in ${edit.path}`,
        edit.path,
      )
    }
    if (onlyRaisesNumericLimits(edit.before, edit.after)) {
      throw new CandidateValidationError(
        "numeric-timing-increase",
        `Candidate only raises a numeric timing limit in ${edit.path}`,
        edit.path,
      )
    }
  }
  return candidate
}

export async function validateCandidatePatch(
  projectRoot: string,
  selectedTest: string,
  allowedSourcePaths: string[],
  value: CandidatePatch,
): Promise<CandidatePatch> {
  return validateCandidateSemantics(await validateCandidateSafety(
    projectRoot,
    selectedTest,
    allowedSourcePaths,
    value,
  ))
}

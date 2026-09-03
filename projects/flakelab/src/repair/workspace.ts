import { createTwoFilesPatch } from "diff"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import type { CandidatePatch } from "./schema.js"

const COPY_ENTRIES = [
  "src",
  "tests",
  "eslint.config.mjs",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "playwright.config.ts",
  "tsconfig.json",
] as const

export interface PatchWorkspace {
  root: string
  cleanup: () => Promise<void>
}

export async function createPatchWorkspace(projectRoot: string): Promise<PatchWorkspace> {
  const parent = resolve(projectRoot, ".flakelab", "patch-sandboxes")
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(resolve(parent, "candidate-"))
  for (const entry of COPY_ENTRIES) {
    await cp(resolve(projectRoot, entry), resolve(root, entry), { recursive: true })
  }
  return {
    root,
    cleanup: async () => rm(root, { force: true, recursive: true }),
  }
}

export async function applyCandidatePatch(
  workspaceRoot: string,
  candidate: CandidatePatch,
): Promise<string> {
  const patches: string[] = []
  for (const edit of candidate.edits) {
    const filePath = resolve(workspaceRoot, edit.path)
    const beforeFile = await readFile(filePath, "utf8")
    const afterFile = beforeFile.replace(edit.before, edit.after)
    if (afterFile === beforeFile) {
      throw new Error(`Candidate edit did not change ${edit.path}`)
    }
    await writeFile(filePath, afterFile, "utf8")
    patches.push(createTwoFilesPatch(
      `a/${edit.path}`,
      `b/${edit.path}`,
      beforeFile,
      afterFile,
      "before",
      "candidate",
      { context: 3 },
    ))
  }
  return patches.join("\n")
}

import { createTwoFilesPatch } from "diff"
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { dirname, relative, resolve, isAbsolute } from "node:path"
import { tmpdir } from "node:os"
import { projectFiles, workspaceRoot, excludedProjectPath } from "./project.js"

import type { CandidatePatch } from "./schema.js"

export interface PatchWorkspace {
  root: string
  uploadRoot: string
  projectDirectory: string
  cleanup: () => Promise<void>
}

interface CopySource {
  path: string
  size: number
}

async function resolvedCopySource(
  sourceRoot: string,
  local: string,
  entry: string,
): Promise<CopySource | undefined> {
  const details = await lstat(local).catch((error: Error) => {
    if ("code" in error && error.code === "ENOENT") return undefined
    throw error
  })
  if (!details) return undefined
  const resolvedPath = resolve(await realpath(local))
  const resolvedFromRoot = relative(sourceRoot, resolvedPath)
  if (resolvedFromRoot.startsWith("..") || isAbsolute(resolvedFromRoot)) {
    throw new Error(`Proof workspace symlink escapes the project: ${entry}`)
  }
  if (!details.isSymbolicLink()) {
    return details.isFile() ? { path: local, size: details.size } : undefined
  }
  const target = resolvedPath
  const targetDetails = await lstat(target)
  if (!targetDetails.isFile()) {
    throw new Error(`Proof workspace symlink must target a regular file: ${entry}`)
  }
  return { path: target, size: targetDetails.size }
}

export async function copyProjectFile(
  sourceRoot: string,
  uploadRoot: string,
  entry: string,
): Promise<number> {
  const local = resolve(sourceRoot, entry)
  const path = relative(sourceRoot, local)
  if (path.startsWith("..") || isAbsolute(path)) throw new Error("Project file escapes workspace")
  const source = await resolvedCopySource(sourceRoot, local, entry)
  if (!source) return 0
  if (source.size > 100 * 1024 * 1024) throw new Error("Proof file exceeds the 100 MiB upload limit")
  if (entry.endsWith(".yarnrc.yml")) {
    const config = await readFile(source.path, "utf8")
    if (/npmAuthToken|npmAuthIdent/u.test(config)) {
      throw new Error("Proof does not upload Yarn registry credentials; use a credential-free registry configuration")
    }
  }
  const destination = resolve(uploadRoot, path)
  await mkdir(dirname(destination), { recursive: true })
  await cp(source.path, destination)
  return source.size
}

export async function createPatchWorkspace(projectRoot: string): Promise<PatchWorkspace> {
  const sourceRoot = await workspaceRoot(projectRoot)
  const uploadRoot = await mkdtemp(resolve(tmpdir(), "flakelab-candidate-"))
  const projectDirectory = relative(sourceRoot, projectRoot).replaceAll("\\", "/")
  const root = resolve(uploadRoot, projectDirectory)
  try {
    const files = await projectFiles(sourceRoot)
    if (files.length > 20_000) throw new Error("Proof workspace exceeds 20,000 files")
    let bytes = 0
    for (const entry of files) {
      if (excludedProjectPath(entry)) continue
      bytes += await copyProjectFile(sourceRoot, uploadRoot, entry)
      if (bytes > 100 * 1024 * 1024) throw new Error("Proof workspace exceeds the 100 MiB upload limit")
    }
  } catch (error) {
    await rm(uploadRoot, { force: true, recursive: true })
    throw error
  }
  return {
    root,
    uploadRoot,
    projectDirectory,
    cleanup: async () => rm(uploadRoot, { force: true, recursive: true }),
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

/** Builds the exact patch without changing the developer's working tree. */
export async function createCandidateDiff(
  projectRoot: string,
  candidate: CandidatePatch,
): Promise<string> {
  const patches = await Promise.all(candidate.edits.map(async (edit) => {
    const beforeFile = await readFile(resolve(projectRoot, edit.path), "utf8")
    const afterFile = beforeFile.replace(edit.before, edit.after)
    if (afterFile === beforeFile) {
      throw new Error(`Candidate edit did not change ${edit.path}`)
    }
    return createTwoFilesPatch(
      `a/${edit.path}`,
      `b/${edit.path}`,
      beforeFile,
      afterFile,
      "before",
      "candidate",
      { context: 3 },
    )
  }))
  return patches.join("\n")
}

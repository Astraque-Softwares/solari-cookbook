import { execFile } from "node:child_process"
import { relative, resolve } from "node:path"
import { promisify } from "node:util"

import type { Revision } from "./schema.js"
import { revisionSchema } from "./schema.js"

const execFileAsync = promisify(execFile)
const MAX_REVISIONS = 1_000

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  })
  return result.stdout.trim()
}

async function resolveCommit(repositoryRoot: string, reference: string): Promise<string> {
  if (reference.length > 200 || /[\r\n\0]/u.test(reference)) {
    throw new Error("Git revision must be a single value no longer than 200 characters")
  }
  return git(repositoryRoot, ["rev-parse", "--verify", `${reference}^{commit}`])
}

async function revisionDetails(repositoryRoot: string, hash: string): Promise<Revision> {
  const subject = await git(repositoryRoot, ["show", "-s", "--format=%s", hash])
  return revisionSchema.parse({ hash, shortHash: hash.slice(0, 12), subject })
}

export interface GitHistory {
  projectPath: string
  repositoryRoot: string
  revisions: Revision[]
}

export async function resolveGitHistory(
  projectRoot: string,
  goodReference: string,
  badReference: string,
): Promise<GitHistory> {
  const repositoryRoot = resolve(await git(projectRoot, ["rev-parse", "--show-toplevel"]))
  const goodHash = await resolveCommit(repositoryRoot, goodReference)
  const badHash = await resolveCommit(repositoryRoot, badReference)
  try {
    await git(repositoryRoot, ["merge-base", "--is-ancestor", goodHash, badHash])
  } catch {
    throw new Error("the selected good revision must be an ancestor of the bad revision")
  }
  const descendants = await git(repositoryRoot, [
    "rev-list",
    "--ancestry-path",
    "--reverse",
    `${goodHash}..${badHash}`,
  ])
  const hashes = [goodHash, ...descendants.split(/\r?\n/u).filter(Boolean)]
  if (hashes.length > MAX_REVISIONS) {
    throw new Error(`bisect history exceeds the ${MAX_REVISIONS}-revision safety limit`)
  }
  const projectPath = relative(repositoryRoot, resolve(projectRoot))
  if (projectPath.startsWith("..")) {
    throw new Error("the project must be inside its Git repository")
  }
  return {
    projectPath,
    repositoryRoot,
    revisions: await Promise.all(hashes.map((hash) => revisionDetails(repositoryRoot, hash))),
  }
}

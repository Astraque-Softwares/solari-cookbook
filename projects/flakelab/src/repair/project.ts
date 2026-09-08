import { execFile } from "node:child_process"
import { readFile, access, readdir, realpath } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { promisify } from "node:util"
import { z } from "zod"

const execute = promisify(execFile)
const excludedNames = new Set(["node_modules", ".git", ".flakelab", ".next", ".env", ".npmrc", ".yarnrc", "test-results", "playwright-report"])
export function excludedProjectPath(path: string): boolean {
  return path.split("/").some((part) => excludedNames.has(part)
    || part.startsWith(".env.") || part.startsWith(".flakelab-")
    || part.endsWith(".pem") || part.endsWith(".key"))
}
const manifestSchema = z.object({
  packageManager: z.string().optional(),
  workspaces: z.union([z.array(z.string()), z.object({ packages: z.array(z.string()) })]).optional(),
  scripts: z.record(z.string(), z.string()).default({}),
  flakelab: z.object({
    proof: z.object({
      setup: z.array(z.string().regex(/^[\w:.-]+$/u)).default([]),
      node: z.string().regex(/^\d+(?:\.\d+\.\d+)?$/u).default("22"),
      environment: z.record(
        z.string().regex(/^[A-Z][A-Z0-9_]*$/u),
        z.string().max(500),
      ).refine(
        (value) => Object.keys(value).length <= 10
          && Object.keys(value).every((key) => !/(?:AUTH|KEY|PASSWORD|SECRET|TOKEN)/u.test(key)),
        "Proof environment accepts at most 10 non-credential variables",
      ).default({}),
    }).strict().optional(),
  }).optional(),
})

export async function exists(path: string): Promise<boolean> {
  try { await access(path); return true } catch { return false }
}

export async function projectManifest(root: string) {
  return manifestSchema.parse(JSON.parse(await readFile(resolve(root, "package.json"), "utf8")))
}

export async function workspaceRoot(project: string): Promise<string> {
  let root = resolve(project)
  let selected = root
  while (dirname(root) !== root) {
    if (await exists(resolve(root, ".git"))) break
    root = dirname(root)
    if (await exists(resolve(root, "pnpm-workspace.yaml"))) selected = root
    if (await exists(resolve(root, "package.json"))) {
      const manifest = await projectManifest(root)
      if (manifest.workspaces) selected = root
    }
    if (await exists(resolve(root, ".git"))) break
  }
  return selected
}

export async function projectFiles(root: string): Promise<string[]> {
  let directory = root
  while (!await exists(resolve(directory, ".git"))) {
    if (dirname(directory) === directory) return walkProject(root)
    directory = dirname(directory)
  }
  const result = await execute("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."], {
    cwd: root, maxBuffer: 16 * 1024 * 1024,
  })
  return [...new Set(result.stdout.split("\0").filter(Boolean))].sort((left, right) => left.localeCompare(right))
}

async function walkProject(root: string, prefix = ""): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(resolve(root, prefix), { withFileTypes: true })) {
    const path = `${prefix}${entry.name}`
    if (excludedProjectPath(path)) continue
    const absolute = resolve(root, path)
    const resolvedPath = resolve(await realpath(absolute))
    const resolvedFromRoot = relative(root, resolvedPath)
    if (resolvedFromRoot.startsWith("..") || isAbsolute(resolvedFromRoot)) {
      throw new Error(`Proof workspace symlink escapes the project: ${path}`)
    }
    if (entry.isDirectory()) files.push(...await walkProject(root, `${path}/`))
    else files.push(path)
    if (files.length > 20_000) throw new Error("Proof workspace exceeds 20,000 files")
  }
  return files.sort((left, right) => left.localeCompare(right))
}

export async function packageManager(root: string): Promise<"npm" | "pnpm" | "yarn" | "bun"> {
  const manifest = await projectManifest(root)
  const explicit = manifest.packageManager?.split("@")[0]
  if (explicit === "npm" || explicit === "pnpm" || explicit === "yarn" || explicit === "bun") return explicit
  for (const [file, manager] of [["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lock", "bun"], ["bun.lockb", "bun"]] as const) {
    if (await exists(resolve(root, file))) return manager
  }
  return "npm"
}

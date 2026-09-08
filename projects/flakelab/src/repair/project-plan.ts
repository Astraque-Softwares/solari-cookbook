import { resolve } from "node:path"
import { readFile } from "node:fs/promises"
import { exists, packageManager, projectManifest } from "./project.js"

export interface ProjectCommand {
  command: string
  args: string[]
  directory: string
}

export async function projectPlan(root: string, directory: string) {
  const manager = await packageManager(root)
  const manifest = await projectManifest(root)
  const target = await projectManifest(resolve(root, directory))
  const version = manifest.packageManager
  if (version && !/^(?:npm|pnpm|yarn|bun)@\d+\.\d+\.\d+(?:\+sha\d+\.[a-f\d]+)?$/u.test(version)) {
    throw new Error("Proof requires an exact packageManager version (for example pnpm@10.0.0)")
  }
  const frozen = await installArguments(root, manager, version)
  const install: ProjectCommand = { command: manager, args: frozen, directory: "" }
  const proof = target.flakelab?.proof ?? { environment: {}, setup: [], node: "22" }
  const setup = proof.setup
  for (const script of setup) {
    if (!target.scripts[script]) throw new Error(`Missing proof setup script: ${script}`)
  }
  const check = (name: string): ProjectCommand | undefined => {
    if (target.scripts[name]) return { command: manager, args: ["run", name], directory }
    if (directory) return undefined
    if (manifest.scripts[name]) return { command: manager, args: ["run", name], directory: "" }
    return undefined
  }
  return {
    manager,
    node: proof.node,
    environment: Object.entries(proof.environment).map(([key, value]) => `${key}=${value}`),
    version: version?.split("+")[0],
    install,
    setup: setup.map((script): ProjectCommand => ({ command: manager, args: ["run", script], directory })),
    typecheck: check("typecheck"),
    lint: check("lint"),
  }
}

async function installArguments(root: string, manager: string, version: string | undefined): Promise<string[]> {
  if (manager === "npm") return [await exists(resolve(root, "package-lock.json")) ? "ci" : "install"]
  if (manager === "yarn") {
    if (!await exists(resolve(root, "yarn.lock"))) return ["install"]
    const modern = version ? !version.startsWith("yarn@1.")
      : (await readFile(resolve(root, "yarn.lock"), "utf8")).includes("__metadata:")
    return ["install", modern ? "--immutable" : "--frozen-lockfile"]
  }
  const lockfiles = manager === "pnpm" ? ["pnpm-lock.yaml"] : ["bun.lock", "bun.lockb"]
  const locked = await Promise.all(lockfiles.map((file) => exists(resolve(root, file))))
  return locked.includes(true) ? ["install", "--frozen-lockfile"] : ["install"]
}

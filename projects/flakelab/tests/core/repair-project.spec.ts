import { test, expect } from "@playwright/test"
import { mkdir, mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { createPatchWorkspace } from "../../src/repair/workspace.js"
import { projectPlan } from "../../src/repair/project-plan.js"
import { checkLabel } from "../../src/repair/summary.js"

async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(resolve(tmpdir(), "flakelab-project-test-"))
  for (const [path, content] of Object.entries(files)) {
    const destination = resolve(root, path)
    await mkdir(resolve(destination, ".."), { recursive: true })
    await writeFile(destination, content)
  }
  return { root, cleanup: async () => rm(root, { recursive: true, force: true }) }
}

test("copies a non-git JavaScript project without requiring FlakeLab files", async () => {
  const source = await fixture({
    "package.json": '{"scripts":{}}', "app.js": "export const value = 1",
    "public/page.html": "hello", ".env": "PRIVATE=value", "node_modules/ignored.js": "ignored",
  })
  try {
    const copy = await createPatchWorkspace(source.root)
    try {
      expect(await readFile(resolve(copy.root, "public/page.html"), "utf8")).toBe("hello")
      await expect(readFile(resolve(copy.root, ".env"))).rejects.toThrow()
      await expect(readFile(resolve(copy.root, "node_modules/ignored.js"))).rejects.toThrow()
      const plan = await projectPlan(copy.uploadRoot, copy.projectDirectory)
      expect(plan.install.args).toEqual(["install"])
      expect(plan.typecheck).toBeUndefined()
      expect(checkLabel(null)).toBe("not configured")
    } finally { await copy.cleanup() }
  } finally { await source.cleanup() }
})

test("retains Yarn monorepo siblings and runs checks from their owning package", async () => {
  const source = await fixture({
    "package.json": JSON.stringify({ packageManager: "yarn@4.17.1", workspaces: ["packages/*"], scripts: { lint: "eslint ." } }),
    "yarn.lock": "lock", "packages/shared/package.json": '{"name":"shared"}',
    "packages/web/package.json": JSON.stringify({ scripts: { typecheck: "tsc", "build:browser": "vite build" }, flakelab: { proof: { setup: ["build:browser"], environment: { E2E_USE_BUILD: "1" } } } }),
  })
  try {
    const copy = await createPatchWorkspace(resolve(source.root, "packages/web"))
    try {
      expect(copy.projectDirectory).toBe("packages/web")
      expect(await readFile(resolve(copy.uploadRoot, "packages/shared/package.json"), "utf8")).toContain("shared")
      const plan = await projectPlan(copy.uploadRoot, copy.projectDirectory)
      expect(plan.install.args).toEqual(["install", "--immutable"])
      expect(plan.typecheck?.directory).toBe("packages/web")
      expect(plan.lint).toEqual({ command: "yarn", args: ["run", "lint"], directory: "" })
      expect(plan.setup[0].args).toEqual(["run", "build:browser"])
      expect(plan.environment).toEqual(["E2E_USE_BUILD=1"])
    } finally { await copy.cleanup() }
  } finally { await source.cleanup() }
})

test("npm lockfiles use ci and invalid setup fails before provider allocation", async () => {
  const source = await fixture({ "package.json": '{"scripts":{}}', "package-lock.json": "{}" })
  try {
    expect((await projectPlan(source.root, "")).install.args).toEqual(["ci"])
    await writeFile(resolve(source.root, "package.json"), '{"flakelab":{"proof":{"setup":["missing"]}}}')
    await expect(projectPlan(source.root, "")).rejects.toThrow("Missing proof setup script")
  } finally { await source.cleanup() }
})

for (const [manager, lock] of [["pnpm@11.6.0", "pnpm-lock.yaml"], ["bun@1.3.0", "bun.lock"]]) {
  test(`${manager} preserves its pinned manager and lockfile policy`, async () => {
    const source = await fixture({
      "package.json": JSON.stringify({ packageManager: manager, flakelab: { proof: { node: "24.1.0" } } }),
      [lock]: "lock",
    })
    try {
      const plan = await projectPlan(source.root, "")
      expect(plan.version).toBe(manager)
      expect(plan.install.args).toEqual(["install", "--frozen-lockfile"])
      expect(plan.node).toBe("24.1.0")
    } finally { await source.cleanup() }
  })
}

test("workspace rejects directory links instead of copying outside files", async () => {
  const source = await fixture({ "package.json": "{}" })
  const outside = await fixture({ "private.txt": "must stay outside" })
  try {
    await symlink(outside.root, resolve(source.root, "linked"), "junction")
    await expect(createPatchWorkspace(source.root)).rejects.toThrow("symlink")
  } finally {
    await source.cleanup()
    await outside.cleanup()
  }
})

test("workspace rejects Yarn authentication settings before upload", async () => {
  const source = await fixture({ "package.json": "{}", ".yarnrc.yml": "npmAuthToken: ${REGISTRY_TOKEN}" })
  try {
    await expect(createPatchWorkspace(source.root)).rejects.toThrow("registry credentials")
  } finally { await source.cleanup() }
})

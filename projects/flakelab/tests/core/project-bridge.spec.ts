import { expect, test } from "@playwright/test"
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { withInterruption } from "../../src/commands/options.js"
import { createTemporaryProjectBridge } from "../../src/runner/project-bridge.js"

test("a temporary project bridge removes its exact file", async () => {
  const projectRoot = process.cwd()
  const bridge = await createTemporaryProjectBridge(
    projectRoot,
    join(projectRoot, "src/runner/trial-reporter.ts"),
    [],
  )
  await expect(lstat(bridge.configPath)).resolves.toBeDefined()
  await bridge.remove()
  await expect(lstat(bridge.configPath)).rejects.toMatchObject({ code: "ENOENT" })
})

test("a temporary project bridge loads configs from paths containing spaces", async ({
  browserName: _browserName,
}, testInfo) => {
  const projectRoot = testInfo.outputPath("consumer with spaces")
  await mkdir(projectRoot, { recursive: true })
  await writeFile(
    join(projectRoot, "playwright.config.ts"),
    "export default { testDir: './tests' }\n",
    "utf8",
  )
  const bridge = await createTemporaryProjectBridge(
    projectRoot,
    join(process.cwd(), "src/runner/trial-reporter.ts"),
    [],
  )

  expect(await readFile(bridge.configPath, "utf8"))
    .toContain('import userConfig from "./playwright.config.ts"')
  await bridge.remove()
})

test("reduced motion reaches pages created directly from the browser fixture", async () => {
  const projectRoot = process.cwd()
  const bridge = await createTemporaryProjectBridge(
    projectRoot,
    join(projectRoot, "src/runner/trial-reporter.ts"),
    [{ kind: "reduced-motion", pattern: "**/*" }],
  )
  try {
    const source = await readFile(bridge.configPath, "utf8")
    expect(source).toContain('const launchFaultArgs = ["--force-prefers-reduced-motion"]')
    expect(source).toContain("args: [...(use.launchOptions?.args ?? []), ...launchFaultArgs]")
    expect(source).toContain("retries: 0")
  } finally {
    await bridge.remove()
  }
})

test("an elapsed-time ceiling aborts work with an actionable error", async () => {
  await expect(withInterruption(
    (signal) => new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true })
    }),
    { maxSeconds: 0.01, timeoutMessage: "Discovery reached its test ceiling" },
  )).rejects.toThrow("Discovery reached its test ceiling")
})

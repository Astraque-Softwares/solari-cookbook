import { expect, test } from "@playwright/test"

import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import { readSafeTestContext, readSafeTestSource } from "../../src/investigator/safe-source.js"

async function prepareFixtureRoot(fixtureRoot: string): Promise<string> {
  await mkdir(fixtureRoot, { recursive: true })
  return fixtureRoot
}

test("safe context follows only bounded local source imports", async (
  { browserName: _browserName },
  testInfo,
) => {
  const fixtureRoot = await prepareFixtureRoot(testInfo.outputPath("safe-source"))
  const dependencyPath = resolve(fixtureRoot, "checkout.ts")
  const testPath = resolve(fixtureRoot, "checkout.spec.ts")
  await writeFile(dependencyPath, "export const deadlineMs = 100\n", "utf8")
  await writeFile(
    testPath,
    'import { deadlineMs } from "./checkout.js"\ntest(String(deadlineMs), async () => true)\n',
    "utf8",
  )

  const context = await readSafeTestContext(process.cwd(), testPath)
  expect(context.map((source) => source.path)).toEqual([
    expect.stringContaining("checkout.spec.ts"),
    expect.stringContaining("checkout.ts"),
  ])
})

test("safe source reader bounds paths and blocks credential-like assignments", async (
  { browserName: _browserName },
  testInfo,
) => {
  const fixtureRoot = await prepareFixtureRoot(testInfo.outputPath("safe-source"))
  const safePath = resolve(fixtureRoot, "checkout.spec.ts")
  await writeFile(safePath, "test('checkout', async () => true)\n", "utf8")
  await expect(readSafeTestSource(process.cwd(), safePath)).resolves.toMatchObject({
    content: expect.stringContaining("checkout"),
  })

  const secretPath = resolve(fixtureRoot, "secret.spec.ts")
  const sensitiveValue = ["credential", "value", "must", "not", "leave"].join("-")
  await writeFile(secretPath, `const apiKey = '${sensitiveValue}'\n`, "utf8")
  await expect(readSafeTestSource(process.cwd(), secretPath)).rejects.toThrow(/credential/u)
  await expect(readSafeTestSource(process.cwd(), "../outside.spec.ts")).rejects.toThrow(
    /inside the project/u,
  )
})

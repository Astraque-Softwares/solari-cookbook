import { expect, test } from "@playwright/test"

import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import {
  discoverRepairSourceCandidates,
  readSafeRepairContext,
  readSafeTestContext,
  readSafeTestSource,
} from "../../src/investigator/safe-source.js"

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

test("safe context accepts Playwright line and column selectors", async (
  { browserName: _browserName },
  testInfo,
) => {
  const fixtureRoot = await prepareFixtureRoot(testInfo.outputPath("located-source"))
  const testPath = resolve(fixtureRoot, "checkout.spec.ts")
  await writeFile(testPath, "test('checkout', async () => true)\n", "utf8")

  const context = await readSafeTestContext(process.cwd(), `${testPath}:108:3`)

  expect(context).toHaveLength(1)
  expect(context[0].path).toContain("checkout.spec.ts")
})

test("investigation context omits imports beyond the provider payload bound", async (
  { browserName: _browserName },
  testInfo,
) => {
  const fixtureRoot = await prepareFixtureRoot(testInfo.outputPath("bounded-context"))
  const testPath = resolve(fixtureRoot, "checkout.spec.ts")
  await writeFile(
    testPath,
    'import { first } from "./first.js"\nimport { second } from "./second.js"\ntest(String(first + second), async () => true)\n',
    "utf8",
  )
  await writeFile(resolve(fixtureRoot, "first.ts"), `export const first = "${"a".repeat(12_000)}"\n`, "utf8")
  await writeFile(resolve(fixtureRoot, "second.ts"), `export const second = "${"b".repeat(12_000)}"\n`, "utf8")

  const context = await readSafeTestContext(process.cwd(), testPath)
  const totalBytes = context.reduce((total, source) => total + Buffer.byteLength(source.content), 0)

  expect(totalBytes).toBeLessThanOrEqual(20 * 1_024)
  expect(context.map((source) => source.path)).toEqual([
    expect.stringContaining("checkout.spec.ts"),
    expect.stringContaining("first.ts"),
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

test("repair context includes explicitly approved application sources", async (
  { browserName: _browserName },
  testInfo,
) => {
  const fixtureRoot = await prepareFixtureRoot(testInfo.outputPath("repair-source"))
  const testPath = resolve(fixtureRoot, "checkout.spec.ts")
  const applicationPath = resolve(fixtureRoot, "checkout-controller.ts")
  await writeFile(testPath, "test('checkout', async () => true)\n", "utf8")
  await writeFile(applicationPath, "export const completeCheckout = () => 'complete'\n", "utf8")

  const context = await readSafeRepairContext(process.cwd(), testPath, [applicationPath])

  expect(context.map((source) => source.path)).toEqual([
    expect.stringContaining("checkout.spec.ts"),
    expect.stringContaining("checkout-controller.ts"),
  ])
})

test("repair context extracts the relevant region from a large approved source", async (
  { browserName: _browserName },
  testInfo,
) => {
  const fixtureRoot = await prepareFixtureRoot(testInfo.outputPath("large-repair-source"))
  const testPath = resolve(fixtureRoot, "checkout.spec.ts")
  const applicationPath = resolve(fixtureRoot, "checkout-controller.ts")
  await writeFile(testPath, "test('checkout', async () => true)\n", "utf8")
  await writeFile(applicationPath, [
    ...Array.from({ length: 2_500 }, (_value, index) => `export const filler${index} = ${index}`),
    "export const accountTitle = 'Motion Accounts'",
    ...Array.from({ length: 2_500 }, (_value, index) => `export const tail${index} = ${index}`),
  ].join("\n"), "utf8")

  const context = await readSafeRepairContext(
    process.cwd(),
    `${testPath}:1`,
    [applicationPath],
    "Expected All Accounts but received Motion Accounts under reduced motion",
  )

  expect(context[1].content).toContain("Motion Accounts")
  expect(context.reduce(
    (total, source) => total + Buffer.byteLength(source.content),
    0,
  )).toBeLessThanOrEqual(12 * 1_024)
})

test("repair source discovery follows local imports from every test in a selected folder", async (
  { browserName: _browserName },
  testInfo,
) => {
  const fixtureRoot = await prepareFixtureRoot(testInfo.outputPath("source-discovery"))
  const testsDirectory = resolve(fixtureRoot, "tests")
  const sourceDirectory = resolve(fixtureRoot, "src")
  await mkdir(testsDirectory, { recursive: true })
  await mkdir(sourceDirectory, { recursive: true })
  await writeFile(
    resolve(testsDirectory, "checkout.spec.ts"),
    'import { checkout } from "../src/checkout.js"\ntest(String(checkout), async () => true)\n',
    "utf8",
  )
  await writeFile(
    resolve(testsDirectory, "cart.spec.ts"),
    'import { cart } from "../src/cart.js"\ntest(String(cart), async () => true)\n',
    "utf8",
  )
  await writeFile(resolve(sourceDirectory, "checkout.ts"), "export const checkout = true\n", "utf8")
  await writeFile(resolve(sourceDirectory, "cart.ts"), "export const cart = true\n", "utf8")

  const candidates = await discoverRepairSourceCandidates(process.cwd(), testsDirectory)

  expect(candidates).toEqual([
    expect.stringContaining("src/cart.ts"),
    expect.stringContaining("src/checkout.ts"),
  ])
})

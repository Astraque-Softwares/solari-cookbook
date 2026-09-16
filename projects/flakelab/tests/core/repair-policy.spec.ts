import type { TestInfo } from "@playwright/test"
import { expect, test } from "@playwright/test"

import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import { candidateOutputTokenBudget } from "../../src/repair/generator.js"
import { validateCandidatePatch } from "../../src/repair/policy.js"

const appPath = "app.ts"
const testPath = "app.spec.ts"

async function createFixture(testInfo: TestInfo): Promise<string> {
  const fixtureRoot = testInfo.outputPath("repair-policy-tests")
  await mkdir(fixtureRoot, { recursive: true })
  await writeFile(resolve(fixtureRoot, appPath), "const deadline = setTimeout(expire, 100)\n", "utf8")
  await writeFile(resolve(fixtureRoot, testPath), "expect(status).toBe('complete')\n", "utf8")
  return fixtureRoot
}

test("candidate generation fits beneath the baseline Groq output-token ceiling", () => {
  expect(candidateOutputTokenBudget(1_000)).toBe(900)
  expect(candidateOutputTokenBudget(800)).toBe(720)
  expect(() => candidateOutputTokenBudget(99)).toThrow(/at least 100/u)
})

test("repair policy permits a narrow application edit", async ({
  browserName: _browserName,
}, testInfo) => {
  const fixtureRoot = await createFixture(testInfo)
  const candidate = {
    summary: "Complete checkout after the request settles",
    rationale: "The completion state should reflect the resolved request",
    edits: [{
      path: resolve(fixtureRoot, appPath),
      before: "const deadline = setTimeout(expire, 100)",
      after: "const deadline = setTimeout(markSlow, 100)",
    }],
  }

  await expect(validateCandidatePatch(
    process.cwd(),
    `${resolve(fixtureRoot, testPath)}:12:3`,
    [resolve(fixtureRoot, appPath).replaceAll("\\", "/")],
    candidate,
  )).resolves.toEqual(candidate)
})

test("repair policy rejects test edits and numeric-only timeout increases", async ({
  browserName: _browserName,
}, testInfo) => {
  const fixtureRoot = await createFixture(testInfo)
  const timeoutIncrease = {
    summary: "Increase the application deadline to hide latency",
    rationale: "A larger timer would make the current example pass",
    edits: [{
      path: resolve(fixtureRoot, appPath),
      before: "const deadline = setTimeout(expire, 100)",
      after: "const deadline = setTimeout(expire, 1000)",
    }],
  }
  await expect(validateCandidatePatch(
    process.cwd(),
    resolve(fixtureRoot, testPath),
    [resolve(fixtureRoot, appPath).replaceAll("\\", "/")],
    timeoutIncrease,
  )).rejects.toThrow(/numeric timing limit/u)

  await expect(validateCandidatePatch(
    process.cwd(),
    resolve(fixtureRoot, testPath),
    [resolve(fixtureRoot, testPath).replaceAll("\\", "/")],
    { ...timeoutIncrease, edits: [{
      path: resolve(fixtureRoot, testPath),
      before: "expect(status).toBe('complete')",
      after: "expect(status).toBeDefined()",
    }] },
  )).rejects.toThrow(/unapproved source/u)
})

test("repair policy matches model snippets to a CRLF source without changing its style", async ({
  browserName: _browserName,
}, testInfo) => {
  const fixtureRoot = testInfo.outputPath("crlf-repair-policy-tests")
  await mkdir(fixtureRoot, { recursive: true })
  await writeFile(
    resolve(fixtureRoot, appPath),
    "const request = await fetch('/api/products')\r\nconst products = await request.json()\r\n",
    "utf8",
  )
  await writeFile(resolve(fixtureRoot, testPath), "expect(products).toBeDefined()\r\n", "utf8")

  const candidate = await validateCandidatePatch(
    fixtureRoot,
    testPath,
    [appPath],
    {
      summary: "Validate the product response before decoding it",
      rationale: "Incomplete responses should not be decoded as complete product data",
      edits: [{
        path: appPath,
        before: "const request = await fetch('/api/products')\nconst products = await request.json()",
        after: "const request = await fetch('/api/products')\nif (!request.ok) throw new Error('Product request failed')\nconst products = await request.json()",
      }],
    },
  )

  expect(candidate.edits[0].before).toContain("\r\n")
  expect(candidate.edits[0].after).toContain("\r\n")
})

import { expect, test } from "@playwright/test"

import { mkdir, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import { validateCandidatePatch } from "../../src/repair/policy.js"

const fixtureRoot = resolve(".flakelab", "repair-policy-tests")
const appPath = "app.ts"
const testPath = "app.spec.ts"

test.beforeEach(async () => {
  await mkdir(fixtureRoot, { recursive: true })
  await writeFile(resolve(fixtureRoot, appPath), "const deadline = setTimeout(expire, 100)\n", "utf8")
  await writeFile(resolve(fixtureRoot, testPath), "expect(status).toBe('complete')\n", "utf8")
})

test.afterEach(async () => {
  await rm(fixtureRoot, { force: true, recursive: true })
})

test("repair policy permits a narrow application edit", async () => {
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
    resolve(fixtureRoot, testPath),
    [resolve(fixtureRoot, appPath).replaceAll("\\", "/")],
    candidate,
  )).resolves.toEqual(candidate)
})

test("repair policy rejects test edits and numeric-only timeout increases", async () => {
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

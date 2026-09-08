import { expect, test } from "@playwright/test"

import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import { nearbyRegressionSelectors } from "../../src/repair/validator.js"
import { remoteFaultArguments } from "../../src/repair/solari-validator.js"
import {
  applyCandidatePatch,
  copyProjectFile,
  createCandidateDiff,
  createPatchWorkspace,
} from "../../src/repair/workspace.js"

test("proof packaging dereferences file symlinks that remain inside the project", async ({
  browserName: _browserName,
}, testInfo) => {
  const sourceRoot = testInfo.outputPath("symlink-source")
  const uploadRoot = testInfo.outputPath("symlink-upload")
  await mkdir(sourceRoot, { recursive: true })
  await writeFile(resolve(sourceRoot, "theme.css"), "body { color: black }\n", "utf8")
  try {
    await symlink("theme.css", resolve(sourceRoot, "dark.css"), "file")
  } catch (error) {
    test.skip(error instanceof Error && "code" in error && error.code === "EPERM")
    throw error
  }

  await copyProjectFile(sourceRoot, uploadRoot, "dark.css")

  await expect(readFile(resolve(uploadRoot, "dark.css"), "utf8")).resolves.toBe(
    "body { color: black }\n",
  )
})

test("candidate edits stay inside a disposable project copy", async () => {
  const sourcePath = "tests/support/checkout-server.ts"
  const originalPath = resolve(sourcePath)
  const original = await readFile(originalPath, "utf8")
  const workspace = await createPatchWorkspace(process.cwd())
  try {
    const diff = await applyCandidatePatch(workspace.root, {
      summary: "Update isolated checkout status behavior",
      rationale: "The workspace copy should change without touching source",
      edits: [{
        path: sourcePath,
        before: "status.textContent = 'Processing'",
        after: "status.textContent = 'Submitting'",
      }],
    })
    expect(diff).toContain("+        status.textContent = 'Submitting'")
    expect(await readFile(originalPath, "utf8")).toBe(original)
    expect(await readFile(resolve(workspace.root, sourcePath), "utf8")).toContain("Submitting")
  } finally {
    await workspace.cleanup()
  }
  await expect(access(workspace.root)).rejects.toThrow()
})

test("candidate diff preview does not change the working tree", async () => {
  const sourcePath = "tests/support/checkout-server.ts"
  const originalPath = resolve(sourcePath)
  const original = await readFile(originalPath, "utf8")

  const diff = await createCandidateDiff(process.cwd(), {
    summary: "Preview an isolated checkout status behavior change",
    rationale: "A terminal preview must not change the developer's source file",
    edits: [{
      path: sourcePath,
      before: "status.textContent = 'Processing'",
      after: "status.textContent = 'Submitting'",
    }],
  })

  expect(diff).toContain("+        status.textContent = 'Submitting'")
  expect(await readFile(originalPath, "utf8")).toBe(original)
})

test("proof transports every supported fault without narrowing it to network delay", () => {
  const faults = [{
    copies: 3,
    kind: "shared-state-interference" as const,
    pattern: "tests/account.spec.ts",
  }]

  expect(remoteFaultArguments(faults, true)).toEqual([
    "--faults-json",
    JSON.stringify(faults),
    "--hostile",
  ])
})

test("nearby regression selection covers nested and co-located test variants", async ({
  browserName: _browserName,
}, testInfo) => {
  const root = testInfo.outputPath("regression-selection")
  await mkdir(resolve(root, "tests/e2e/nested"), { recursive: true })
  await mkdir(resolve(root, "src/checkout"), { recursive: true })
  await Promise.all([
    writeFile(resolve(root, "tests/e2e/checkout.spec.ts"), "", "utf8"),
    writeFile(resolve(root, "tests/e2e/nested/cart.test.tsx"), "", "utf8"),
    writeFile(resolve(root, "tests/e2e/nested/ignored.ts"), "", "utf8"),
    writeFile(resolve(root, "src/checkout/checkout.ts"), "", "utf8"),
    writeFile(resolve(root, "src/checkout/checkout.spec.js"), "", "utf8"),
  ])

  const selectors = await nearbyRegressionSelectors(
    root,
    "tests/e2e/checkout.spec.ts",
    {
      summary: "Update checkout completion after the request settles",
      rationale: "The application should transition only after the response arrives",
      edits: [{ path: "src/checkout/checkout.ts", before: "before", after: "after" }],
    },
  )

  expect(selectors).toEqual([
    "src/checkout/checkout.spec.js",
    "tests/e2e/nested/cart.test.tsx",
  ])
})

test("nearby regression selection caps large suites instead of rejecting them", async ({
  browserName: _browserName,
}, testInfo) => {
  const root = testInfo.outputPath("large-regression-selection")
  await mkdir(resolve(root, "tests"), { recursive: true })
  await Promise.all(Array.from({ length: 9 }, async (_, index) =>
    writeFile(resolve(root, `tests/case-${index}.spec.ts`), "", "utf8")))
  const selected = "tests/case-8.spec.ts"
  const selectors = await nearbyRegressionSelectors(root, selected, {
    summary: "Exercise bounded regression selection in a large test directory",
    rationale: "Large open-source repositories must not be rejected before isolated proof",
    edits: [{ path: "tests/case-8.spec.ts", before: "before", after: "after" }],
  })
  expect(selectors).toHaveLength(5)
  expect(selectors).not.toContain(selected)
})

import { expect, test } from "@playwright/test"

import { access, readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { applyCandidatePatch, createPatchWorkspace } from "../../src/repair/workspace.js"

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

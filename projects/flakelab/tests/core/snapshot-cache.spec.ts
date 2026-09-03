import { expect, test } from "@playwright/test"

import { snapshotCacheKey } from "../../src/solari/run-demo.js"

test("snapshot cache keys are stable and include every preparation input", () => {
  const key = snapshotCacheKey("commit-a", "lockfile-a", "fixture-a")

  expect(snapshotCacheKey("commit-a", "lockfile-a", "fixture-a")).toBe(key)
  expect(snapshotCacheKey("commit-b", "lockfile-a", "fixture-a")).not.toBe(key)
  expect(snapshotCacheKey("commit-a", "lockfile-b", "fixture-a")).not.toBe(key)
  expect(snapshotCacheKey("commit-a", "lockfile-a", "fixture-b")).not.toBe(key)
})

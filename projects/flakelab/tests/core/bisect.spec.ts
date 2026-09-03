import { expect, test } from "@playwright/test"
import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { classifyFailureProbability, wilsonInterval80 } from "../../src/bisect/confidence.js"
import { statisticalBisect } from "../../src/bisect/engine.js"
import { resolveGitHistory } from "../../src/bisect/git.js"
import type { Revision, RevisionEvidence } from "../../src/bisect/schema.js"

const execFileAsync = promisify(execFile)

function revisions(count: number): Revision[] {
  return Array.from({ length: count }, (_, index) => ({
    hash: index.toString(16).padStart(40, "0"),
    shortHash: index.toString(16).padStart(12, "0"),
    subject: `revision ${index}`,
  }))
}

function evidence(
  revision: Revision,
  classification: RevisionEvidence["classification"],
): RevisionEvidence {
  const isBad = classification === "bad"
  const incompatible = classification === "incompatible"
  return {
    revision,
    classification,
    reason: incompatible ? "historical build is incompatible" : "statistical decision",
    trials: incompatible ? 0 : 4,
    passed: isBad || incompatible ? 0 : 4,
    failed: isBad ? 4 : 0,
    errors: 0,
    failureRate: isBad ? 1 : 0,
    lowerBound80: isBad ? 0.709 : 0,
    upperBound80: isBad ? 1 : 0.291,
    snapshotReuseCount: incompatible ? 0 : 3,
    durationMs: 10,
  }
}

test("classifies failure probability only when the interval clears the threshold", () => {
  expect(classifyFailureProbability(4, 4, 0, 0.7)).toBe("bad")
  expect(classifyFailureProbability(0, 4, 0, 0.7)).toBe("good")
  expect(classifyFailureProbability(3, 4, 0, 0.7)).toBe("inconclusive")
  expect(classifyFailureProbability(4, 4, 1, 0.7)).toBe("inconclusive")
  expect(classifyFailureProbability(0, 12, 1, 0.7)).toBe("good")

  const interval = wilsonInterval80(4, 4)
  expect(interval.lower).toBeGreaterThan(0.7)
  expect(interval.upper).toBe(1)
})

test("finds the first failing revision while evaluating midpoint preparations in parallel", async () => {
  const history = revisions(9)
  let active = 0
  let peak = 0
  const report = await statisticalBisect({
    revisions: history,
    minimumFailureRate: 0.7,
    parallelism: 2,
    evaluate: async (revision) => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      const index = history.indexOf(revision)
      return evidence(revision, index >= 5 ? "bad" : "good")
    },
  })

  expect(report.exact).toBe(true)
  expect(report.firstFailingCommit).toEqual(history[5])
  expect(report.earliestKnownBadCommit).toEqual(history[5])
  expect(peak).toBe(2)
  expect(report.evidence.every((item) => item.snapshotReuseCount === 3)).toBe(true)
})

test("reports the earliest proven bad revision when an incompatible commit hides the boundary", async () => {
  const history = revisions(5)
  const report = await statisticalBisect({
    revisions: history,
    minimumFailureRate: 0.7,
    evaluate: (revision) => {
      const index = history.indexOf(revision)
      if (index === 2) {
        return Promise.resolve(evidence(revision, "incompatible"))
      }
      return Promise.resolve(evidence(revision, index >= 3 ? "bad" : "good"))
    },
  })

  expect(report.exact).toBe(false)
  expect(report.firstFailingCommit).toBeNull()
  expect(report.earliestKnownBadCommit).toEqual(history[3])
  expect(report.evidence.find((item) => item.revision.hash === history[2].hash)?.classification)
    .toBe("incompatible")
})

test("rejects non-monotonic histories", async () => {
  const history = revisions(4)
  await expect(statisticalBisect({
    revisions: history,
    minimumFailureRate: 0.7,
    evaluate: (revision) => {
      const index = history.indexOf(revision)
      return Promise.resolve(evidence(revision, index === 1 || index === 3 ? "bad" : "good"))
    },
  })).rejects.toThrow("non-monotonic")
})

test("resolves an ordered ancestry path from a real Git history", async () => {
  const repository = await mkdtemp(join(tmpdir(), "flakelab-bisect-"))
  try {
    await execFileAsync("git", ["init", "--quiet"], { cwd: repository })
    await execFileAsync("git", ["config", "user.email", "flakelab@example.invalid"], {
      cwd: repository,
    })
    await execFileAsync("git", ["config", "user.name", "FlakeLab Test"], { cwd: repository })
    const hashes: string[] = []
    for (let index = 0; index < 3; index += 1) {
      await writeFile(join(repository, "fixture.txt"), `revision ${index}\n`, "utf8")
      await execFileAsync("git", ["add", "fixture.txt"], { cwd: repository })
      await execFileAsync("git", ["commit", "--quiet", "-m", `revision ${index}`], {
        cwd: repository,
      })
      const result = await execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: repository,
        encoding: "utf8",
      })
      hashes.push(result.stdout.trim())
    }

    const history = await resolveGitHistory(repository, hashes[0], "HEAD")

    expect(history.revisions.map((revision) => revision.hash)).toEqual(hashes)
    expect(history.revisions.map((revision) => revision.subject)).toEqual([
      "revision 0",
      "revision 1",
      "revision 2",
    ])
    expect(history.projectPath).toBe("")
  } finally {
    await rm(repository, { recursive: true, force: true })
  }
})

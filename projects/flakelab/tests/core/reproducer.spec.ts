import { expect, test } from "@playwright/test"

import { readReproducer, writeReproducer } from "../../src/reproducer/file.js"

test("portable YAML reproducers round-trip through strict validation", async ({
  browserName: _browserName,
}, testInfo) => {
  const filePath = testInfo.outputPath("flakelab.repro.yaml")
  const reproducer = {
    version: 1 as const,
    test: "tests/checkout.spec.ts",
    seed: 42,
    trials: 4,
    faults: [{ kind: "network-delay" as const, pattern: "**/api/checkout", delayMs: 100 }],
    expectedFailure: { minimumRate: 0.7, signature: "checkout-timeout" },
  }

  await writeReproducer(filePath, reproducer)

  expect(await readReproducer(filePath)).toEqual(reproducer)
})

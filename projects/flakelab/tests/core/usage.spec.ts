import { expect, test } from "@playwright/test"

import { ResourceUsageTracker } from "../../src/solari/usage.js"

test("resource accounting reports balanced cleanup and peak concurrency", () => {
  const tracker = new ResourceUsageTracker()
  tracker.sandboxCreated()
  tracker.sandboxCreated()
  tracker.browserCreated()
  const firstTrial = tracker.trialStarted()
  const secondTrial = tracker.trialStarted()
  tracker.trialCompleted(firstTrial)
  tracker.trialCompleted(secondTrial)
  tracker.retry()
  tracker.browserClosed()
  tracker.sandboxKilled()
  tracker.sandboxKilled()

  expect(tracker.snapshot()).toMatchObject({
    peakConcurrency: 2,
    sandboxesCreated: 2,
    sandboxesKilled: 2,
    browserSessionsCreated: 1,
    browserSessionsClosed: 1,
    infrastructureRetries: 1,
    snapshotCacheHit: false,
  })
})

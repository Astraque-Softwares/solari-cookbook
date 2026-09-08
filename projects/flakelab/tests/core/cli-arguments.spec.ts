import { expect, test } from "@playwright/test"

import { parseCliArguments } from "../../src/cli-arguments.js"

test("the shortest invocation scans an explicit target", () => {
  const invocation = parseCliArguments(["."])

  expect(invocation).toEqual({
    command: "scan",
    target: ".",
    options: {
      artifacts: ".flakelab/runs",
      concurrency: "2",
      json: false,
      runs: "4",
      verbose: false,
    },
  })
})

test("the scan command never silently chooses the current directory", () => {
  expect(() => parseCliArguments(["scan"])).toThrow("scan requires exactly one target")
  expect(parseCliArguments(["scan", "."])).toMatchObject({ command: "scan", target: "." })
})

test("commands reject options that they do not use", () => {
  expect(() => parseCliArguments(["scan", ".", "--open"])).toThrow("Unknown option '--open'")
  expect(() => parseCliArguments(["doctor", "--runs", "2"])).toThrow("Unknown option '--runs'")
})

test("discover selects a bounded fault family explicitly", () => {
  expect(parseCliArguments([
    "discover",
    "tests/payload.spec.ts",
    "--fault",
    "response-truncation",
    "--max-remove-bytes",
    "64",
  ])).toMatchObject({
    command: "discover",
    target: "tests/payload.spec.ts",
    options: {
      fault: "response-truncation",
      "max-remove-bytes": "64",
      "max-seconds": "600",
    },
  })
  expect(parseCliArguments([
    "discover",
    "tests/payload.spec.ts",
    "--fault",
    "response-duplication",
    "--max-duplicate-bytes",
    "32",
  ])).toMatchObject({
    command: "discover",
    options: {
      fault: "response-duplication",
      "max-duplicate-bytes": "32",
    },
  })
  expect(parseCliArguments([
    "discover",
    "tests/search.spec.ts",
    "--fault",
    "response-reordering",
    "--max-hold-ms",
    "75",
  ])).toMatchObject({
    command: "discover",
    options: {
      fault: "response-reordering",
      "max-hold-ms": "75",
    },
  })
  expect(parseCliArguments([
    "discover",
    "tests/startup.spec.ts",
    "--fault",
    "resource-loading-delay",
    "--resource-type",
    "script",
    "--max-delay",
    "100",
  ])).toMatchObject({
    command: "discover",
    options: {
      fault: "resource-loading-delay",
      "max-delay": "100",
      "resource-type": "script",
    },
  })
  expect(parseCliArguments([
    "discover",
    "tests/hydration.spec.ts",
    "--fault",
    "startup-event-delay",
    "--startup-event",
    "dom-content-loaded",
    "--max-delay",
    "750",
  ])).toMatchObject({
    command: "discover",
    options: {
      fault: "startup-event-delay",
      "max-delay": "750",
      "startup-event": "dom-content-loaded",
    },
  })
  expect(parseCliArguments([
    "discover",
    "tests/interaction.spec.ts",
    "--fault",
    "event-loop-stall",
    "--max-stall-ms",
    "500",
    "--stall-after-ms",
    "25",
  ])).toMatchObject({
    command: "discover",
    options: {
      fault: "event-loop-stall",
      "max-stall-ms": "500",
      "stall-after-ms": "25",
    },
  })
  expect(parseCliArguments([
    "discover",
    "tests/auth.spec.ts",
    "--fault",
    "auth-cookie-expiry",
    "--cookie-name",
    "session-id",
  ])).toMatchObject({
    command: "discover",
    options: {
      "cookie-name": "session-id",
      fault: "auth-cookie-expiry",
    },
  })
  expect(parseCliArguments([
    "discover",
    "tests/storage.spec.ts",
    "--fault",
    "storage-state-delay",
    "--storage",
    "session-storage",
    "--storage-key",
    "auth-token",
  ])).toMatchObject({
    command: "discover",
    options: {
      fault: "storage-state-delay",
      storage: "session-storage",
      "storage-key": "auth-token",
    },
  })
  expect(parseCliArguments([
    "discover", "tests/time.spec.ts", "--fault", "clock-jump",
    "--clock-offset-ms=-3600000", "--jump-after-ms", "25",
  ])).toMatchObject({
    command: "discover",
    options: { fault: "clock-jump", "clock-offset-ms": "-3600000", "jump-after-ms": "25" },
  })
  expect(parseCliArguments([
    "discover", "tests/locale.spec.ts", "--fault", "locale", "--locale", "fr-FR",
  ])).toMatchObject({ command: "discover", options: { fault: "locale", locale: "fr-FR" } })
  expect(parseCliArguments([
    "discover", "tests/timezone.spec.ts", "--fault", "timezone",
    "--timezone", "America/New_York",
  ])).toMatchObject({
    command: "discover",
    options: { fault: "timezone", timezone: "America/New_York" },
  })
  expect(parseCliArguments([
    "discover", "tests/animation.spec.ts", "--fault", "animation-speed",
    "--animation-rate", "5",
  ])).toMatchObject({
    command: "discover",
    options: { fault: "animation-speed", "animation-rate": "5" },
  })
  expect(parseCliArguments([
    "discover", "tests/motion.spec.ts", "--fault", "reduced-motion",
  ])).toMatchObject({ command: "discover", options: { fault: "reduced-motion" } })
  expect(parseCliArguments([
    "discover", "tests/layout.spec.ts", "--fault", "viewport",
    "--viewport-width", "375", "--viewport-height", "667",
  ])).toMatchObject({
    command: "discover",
    options: { fault: "viewport", "viewport-width": "375", "viewport-height": "667" },
  })
  expect(parseCliArguments([
    "discover", "tests/parallel.spec.ts", "--fault", "worker-pressure", "--max-workers", "6",
  ])).toMatchObject({
    command: "discover",
    options: { fault: "worker-pressure", "max-workers": "6" },
  })
  expect(parseCliArguments([
    "discover", "tests/account.spec.ts", "--fault", "shared-state-interference",
    "--max-copies", "5",
  ])).toMatchObject({
    command: "discover",
    options: { fault: "shared-state-interference", "max-copies": "5" },
  })
})

test("analyze accepts one report source and only its own options", () => {
  expect(parseCliArguments([
    "analyze",
    "blob reports",
    "--baseline",
    "previous.json",
    "--json",
  ])).toEqual({
    command: "analyze",
    options: {
      artifacts: ".flakelab/runs",
      baseline: "previous.json",
      json: true,
      verbose: false,
    },
    target: "blob reports",
  })
  expect(() => parseCliArguments(["analyze"])).toThrow(
    "analyze requires exactly one blob report path",
  )
  expect(() => parseCliArguments(["analyze", "blob-report", "--runs", "2"]))
    .toThrow("Unknown option '--runs'")
})

test("diagnose accepts a target or a read-only report and gates new experiments", () => {
  expect(parseCliArguments(["diagnose", "tests/checkout.spec.ts"])).toMatchObject({
    command: "diagnose",
    options: {
      concurrency: "2",
      discover: false,
      investigate: false,
      "max-seconds": "600",
      "max-steps": "4",
      repair: false,
    },
    target: "tests/checkout.spec.ts",
  })
  expect(parseCliArguments([
    "diagnose",
    "--report",
    "blob reports",
    "--baseline",
    "previous.json",
  ])).toMatchObject({
    command: "diagnose",
    options: { baseline: "previous.json", report: "blob reports" },
  })
  expect(parseCliArguments([
    "diagnose",
    "tests/checkout.spec.ts",
    "--report",
    "blob reports",
    "--repair",
    "--source",
    "src/checkout.ts",
  ])).toMatchObject({
    command: "diagnose",
    options: { repair: true, report: "blob reports", source: ["src/checkout.ts"] },
    target: "tests/checkout.spec.ts",
  })
  expect(() => parseCliArguments(["diagnose"])).toThrow(
    "diagnose requires a test target or --report",
  )
  expect(() => parseCliArguments(["diagnose", "--report", "blob.zip", "--discover"]))
    .toThrow("needs an explicit test target")
  expect(() => parseCliArguments(["diagnose", "tests/example.spec.ts", "--delay-ms", "20"]))
    .toThrow("Unknown option '--delay-ms'")
})

test("report accepts its own output options", () => {
  const invocation = parseCliArguments(["report", "investigation.json", "--open"])

  expect(invocation).toMatchObject({
    command: "report",
    target: "investigation.json",
    options: { open: true },
  })
})

test("repair exposes an explicit model cost ceiling", () => {
  expect(parseCliArguments([
    "repair",
    "flakelab.investigation.json",
    "--max-cost",
    "0.10",
    "--source",
    "src/checkout.ts",
    "--source",
    "src/cart.ts",
  ])).toMatchObject({
    command: "repair",
    options: {
      concurrency: "1",
      "max-cost": "0.10",
      source: ["src/checkout.ts", "src/cart.ts"],
    },
    target: "flakelab.investigation.json",
  })
})

test("prove works as a command and as a target shortcut", () => {
  const command = parseCliArguments([
    "prove", "tests/checkout.spec.ts", "--open", "--source", "src/checkout.ts",
    "--fault", "viewport", "--viewport-width", "390", "--viewport-height", "844",
  ])
  const shortcut = parseCliArguments([
    "tests/checkout.spec.ts", "--prove", "--open", "--source", "src/checkout.ts",
    "--fault", "viewport", "--viewport-width", "390", "--viewport-height", "844",
  ])

  expect(command).toMatchObject({
    command: "prove",
    options: {
      concurrency: "2",
      fault: "viewport",
      "max-seconds": "600",
      "max-steps": "4",
      source: ["src/checkout.ts"],
      "viewport-height": "844",
      "viewport-width": "390",
    },
    target: "tests/checkout.spec.ts",
  })
  expect(shortcut).toEqual(command)
})

test("prove uses one custom reproducer path throughout the pipeline", () => {
  const invocation = parseCliArguments([
    "prove",
    "tests/checkout.spec.ts",
    "--reproducer",
    ".flakelab/runs/checkout.repro.yaml",
  ])

  expect(invocation).toMatchObject({
    command: "prove",
    options: {
      output: ".flakelab/runs/checkout.repro.yaml",
      reproducer: ".flakelab/runs/checkout.repro.yaml",
    },
  })
  expect(() => parseCliArguments([
    "prove",
    "tests/checkout.spec.ts",
    "--output",
    "legacy.repro.yaml",
  ])).toThrow("Unknown option '--output'")
})

test("targetless commands enforce their input contract", () => {
  expect(() => parseCliArguments(["doctor", "."])).toThrow("doctor does not accept a target")
  expect(() => parseCliArguments(["bisect"])).toThrow("bisect requires --good <revision>")
  expect(() => parseCliArguments(["bisect", "main", "--good", "v1"])).toThrow(
    "bisect does not accept a target",
  )
})

test("resume accepts exactly one diagnosis checkpoint", () => {
  expect(parseCliArguments(["resume", ".flakelab/runs/diagnose.json"])).toEqual({
    command: "resume",
    target: ".flakelab/runs/diagnose.json",
  })
  expect(() => parseCliArguments(["resume"])).toThrow(
    "resume requires exactly one diagnosis checkpoint",
  )
  expect(() => parseCliArguments(["resume", "diagnose.json", "--runs", "2"]))
    .toThrow("Unknown option '--runs'")
})

test("help and version remain global", () => {
  expect(parseCliArguments([])).toEqual({ command: "help" })
  expect(parseCliArguments(["--help"])).toEqual({ command: "help" })
  expect(parseCliArguments(["--version"])).toEqual({ command: "version" })
})

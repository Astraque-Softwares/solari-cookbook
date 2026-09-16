import { expect, test } from "@playwright/test"

import { doctor } from "../../src/commands/doctor.js"
import { formatScanSummary } from "../../src/commands/scan.js"
import type { ScanResult } from "../../src/commands/scan.js"
import { helpText } from "../../src/cli-help.js"
import { parseCliArguments } from "../../src/cli-arguments.js"
import { formatProviderBoundary } from "../../src/ui/boundary.js"
import { TerminalDocument } from "../../src/ui/document.js"
import { formatCandidateDiff } from "../../src/ui/diff.js"
import { ProgressReporter } from "../../src/ui/progress.js"
import { displayWidth, sanitizeLine, sanitizeText, stripAnsi } from "../../src/ui/text.js"
import type { TerminalContext } from "../../src/ui/theme.js"
import { colorEnabled, createTheme, terminalWidth } from "../../src/ui/theme.js"

const ESCAPE = String.fromCodePoint(0x1b)
const TAB = String.fromCodePoint(0x09)
const NEWLINE = String.fromCodePoint(0x0a)
const CURSOR_SEQUENCES = [`${ESCAPE}[2K`, `${ESCAPE}[1A`, `${ESCAPE}[?25l`, "\r"]

function context(overrides: Partial<TerminalContext> = {}): TerminalContext {
  return {
    env: {},
    isTTY: true,
    platform: "linux",
    ...overrides,
  }
}

function scanArtifact(status: ScanResult["status"], target: string): ScanResult {
  return {
    generatedAt: "2026-09-06T00:00:00.000Z",
    playwrightOutputDirectory: null,
    runs: 4,
    runnerErrors: [],
    status,
    target,
    tests: [],
    totals: {
      errors: 0,
      executions: 4,
      failed: status === "no-failure-observed" ? 0 : 2,
      failureRate: status === "no-failure-observed" ? 0 : 0.5,
      lowerBound80: 0,
      skipped: 0,
      passed: status === "no-failure-observed" ? 4 : 2,
      upperBound80: 0.29,
    },
    workers: 1,
  }
}

test("an interactive terminal gets color and a redirected stream does not", () => {
  expect(colorEnabled(context())).toBe(true)
  expect(colorEnabled(context({ isTTY: false }))).toBe(false)

  const interactive = new TerminalDocument(createTheme(context()))
    .verdict("success", "no-failure-observed")
    .render()
  const redirected = new TerminalDocument(createTheme(context({ isTTY: false })))
    .verdict("success", "no-failure-observed")
    .render()

  expect(interactive).toContain(ESCAPE)
  expect(redirected).not.toContain(ESCAPE)
  expect(stripAnsi(interactive)).toBe(redirected)
})

test("NO_COLOR, a dumb terminal, and CI all disable color on a real terminal", () => {
  expect(colorEnabled(context({ env: { NO_COLOR: "1" } }))).toBe(false)
  expect(colorEnabled(context({ env: { NO_COLOR: "0" } }))).toBe(false)
  expect(colorEnabled(context({ env: { NO_COLOR: "" } }))).toBe(true)
  expect(colorEnabled(context({ env: { TERM: "dumb" } }))).toBe(false)
  expect(colorEnabled(context({ env: { CI: "true" } }))).toBe(false)
  expect(colorEnabled(context({ env: { CI: "true", FORCE_COLOR: "1" } }))).toBe(true)
  expect(colorEnabled(context({ env: { FORCE_COLOR: "0" }, isTTY: true }))).toBe(false)
  expect(colorEnabled(context({ env: { FORCE_COLOR: "1", NO_COLOR: "1" } }))).toBe(false)
  expect(colorEnabled(context({ env: { FORCE_COLOR: "1" }, isTTY: false }))).toBe(true)
})

test("every status carries a distinct symbol and label, not color alone", () => {
  const plain = createTheme(context({ isTTY: false }))
  const rendered = [
    new TerminalDocument(plain).entry("success", "candidate accepted").render(),
    new TerminalDocument(plain).entry("failure", "candidate rejected").render(),
    new TerminalDocument(plain).entry("inconclusive", "inconclusive").render(),
    new TerminalDocument(plain).entry("warning", "mixed-outcomes").render(),
  ]

  expect(rendered[0]).toBe("  ✓  candidate accepted")
  expect(rendered[1]).toBe("  ✗  candidate rejected")
  expect(rendered[2]).toBe("  ?  inconclusive")
  expect(rendered[3]).toBe("  !  mixed-outcomes")
  expect(new Set(rendered.map((line) => line.trim()[0])).size).toBe(4)
})

test("a Windows console without Unicode support falls back to ASCII symbols", () => {
  const legacy = createTheme(context({ isTTY: false, platform: "win32" }))
  const modern = createTheme(context({
    env: { WT_SESSION: "1" },
    isTTY: false,
    platform: "win32",
  }))

  expect(legacy.unicode).toBe(false)
  expect(modern.unicode).toBe(true)
  expect(new TerminalDocument(legacy).entry("success", "ready").render()).toBe("  +  ready")
  expect(new TerminalDocument(legacy).heading("doctor").render().split(NEWLINE)[1])
    .toBe("FlakeLab - doctor")
})

test("terminal escape sequences in evidence values cannot reach the terminal", () => {
  const bell = String.fromCodePoint(0x07)
  const rightToLeftOverride = String.fromCodePoint(0x202e)
  const hostile = `checkout${ESCAPE}[31m red${ESCAPE}[2K${rightToLeftOverride}reversed${bell}`
  const document = new TerminalDocument(createTheme(context({ isTTY: false })))
    .entry("failure", hostile)
    .rows([{ label: "Target", value: hostile }])
    .command(hostile)
    .render()

  expect(document).toContain("checkout[31m red[2Kreversed")
  expect(document).not.toContain(ESCAPE)
  expect(document).not.toContain(rightToLeftOverride)
  expect(document).not.toContain(bell)
  expect(sanitizeLine(`a${TAB}b${NEWLINE}c`)).toBe("a b c")
  expect(sanitizeText(`keep${NEWLINE}newlines`)).toBe(`keep${NEWLINE}newlines`)
})

test("output stays within a narrow terminal and wraps on word boundaries", () => {
  const theme = createTheme(context({ columns: 40, isTTY: false }))
  expect(theme.width).toBe(40)
  expect(terminalWidth(context({ columns: 10 }))).toBe(40)
  expect(terminalWidth(context({ columns: 400 }))).toBe(100)
  expect(terminalWidth(context())).toBe(80)

  const summary = formatScanSummary(
    scanArtifact("mixed-outcomes", "tests/checkout.spec.ts"),
    ".flakelab/runs/scan.json",
    theme,
  )
  const prose = summary
    .split("\n")
    .filter((line) => !line.includes("/") && !line.includes("flakelab "))

  expect(prose.every((line) => displayWidth(line) <= theme.width)).toBe(true)
  expect(summary).toContain("Mixed outcomes observed")
})

test("progress reporting writes plain, line-oriented stages to its own stream", () => {
  const chunks: string[] = []
  const reporter = new ProgressReporter({
    theme: createTheme(context({ isTTY: false })),
    write: (chunk) => chunks.push(chunk),
  })

  reporter.start("stability scan", "4 native Playwright runs")
  reporter.step("trial 1 · passed · 1.2s")
  reporter.done("no-failure-observed")
  const output = chunks.join("")

  expect(output).toContain("› stability scan · 4 native Playwright runs")
  expect(output).toContain("· trial 1 · passed · 1.2s")
  expect(output).toContain("✓ stability scan · no-failure-observed")
  for (const sequence of CURSOR_SEQUENCES) {
    expect(output).not.toContain(sequence)
  }
  expect(output.split("\n").filter((line) => line !== "")).toHaveLength(3)
})

test("interactive progress pulses during quiet intervals without cursor control", () => {
  const chunks: string[] = []
  let pulse = (): void => undefined
  const reporter = new ProgressReporter({
    animate: true,
    schedulePulse: (scheduled) => {
      pulse = scheduled
      return (): void => undefined
    },
    theme: createTheme(context({ isTTY: false })),
    write: (chunk) => chunks.push(chunk),
  })

  reporter.start("repair candidate", "policy-bounded generation")
  pulse()
  pulse()
  reporter.done("1 source edit")

  const output = chunks.join("")
  expect(output).toContain("· working..\n")
  expect(output).toContain("✓ repair candidate · 1 source edit")
  for (const sequence of CURSOR_SEQUENCES) {
    expect(output).not.toContain(sequence)
  }
})

test("command failures close an active progress pulse before the error", () => {
  const chunks: string[] = []
  let pulse = (): void => undefined
  const reporter = new ProgressReporter({
    animate: true,
    schedulePulse: (scheduled) => {
      pulse = scheduled
      return (): void => undefined
    },
    theme: createTheme(context({ isTTY: false })),
    write: (chunk) => chunks.push(chunk),
  })

  reporter.start("investigation")
  pulse()
  ProgressReporter.failActive()

  expect(chunks.join("")).toContain("· working.\n✗ investigation · failed")
})

test("candidate diffs are sanitized, colored by meaning, and bounded", () => {
  const hostile = `${ESCAPE}[2K`
  const diff = [
    "--- a/src/checkout.ts",
    "+++ b/src/checkout.ts",
    "@@ -1 +1 @@",
    `-submit()${hostile}`,
    "+await submit()",
  ].join("\n")
  const rendered = formatCandidateDiff(diff, "candidate.diff", createTheme(context()))

  expect(stripAnsi(rendered)).toContain("Candidate diff")
  expect(stripAnsi(rendered)).toContain("-submit()[2K")
  expect(rendered).toContain(ESCAPE)
  expect(rendered).not.toContain(`${ESCAPE}[2K`)
})

test("a completed command names its result, its evidence, and the next command", () => {
  const plain = createTheme(context({ isTTY: false }))
  const clean = formatScanSummary(
    scanArtifact("no-failure-observed", "tests/checkout.spec.ts"),
    ".flakelab/runs/scan.json",
    plain,
  )
  const mixed = formatScanSummary(
    scanArtifact("mixed-outcomes", "tests/checkout spec.ts"),
    ".flakelab/runs/scan.json",
    plain,
  )

  expect(clean).toContain("✓  no-failure-observed")
  expect(clean).toContain("Scan artifact  .flakelab/runs/scan.json")
  expect(clean.trimEnd().endsWith("flakelab scan tests/checkout.spec.ts --runs 20")).toBe(true)
  expect(mixed).toContain("!  mixed-outcomes")
  expect(mixed.trimEnd()).toContain('flakelab diagnose "tests/checkout spec.ts" --discover')
})

test("provider work announces its boundary before any chargeable operation", () => {
  const notice = formatProviderBoundary({
    credentials: ["GROQ_API_KEY", "SOLARI_API_KEY"],
    detail: "Candidate generation sends the investigation summary to Groq.",
    rows: [{ label: "Cost ceiling", value: "$0.25" }],
    stage: "Groq repair candidate and isolated Solari proof",
  }, createTheme(context({ isTTY: false })))

  expect(notice).toContain("!  provider work · Groq repair candidate and isolated Solari proof")
  expect(notice).toContain("GROQ_API_KEY · SOLARI_API_KEY")
  expect(notice).toContain("Cost ceiling  $0.25")
})

test("doctor speaks the same status language as the other commands", async () => {
  let output = ""
  await doctor({
    environment: {},
    loadEnvironmentFile: false,
    write: (message) => {
      output += message
    },
  })

  expect(output).toContain("FlakeLab · doctor")
  expect(output).toMatch(/^ {2}[✓!] {2}ready/mu)
  expect(output).toContain("Environment")
  expect(output).toContain("Credentials")
  expect(output).not.toContain(ESCAPE)
})

test("help is scannable and every command exposes its own options", () => {
  const main = helpText()

  expect(main).toContain("Observe")
  expect(main).toContain("Reproduce")
  expect(main).toContain("Explain and prove")
  expect(main).toContain("flakelab <command> --help")
  expect(main.split("\n").length).toBeLessThan(60)

  expect(parseCliArguments(["discover", "--help"])).toEqual({
    command: "help",
    topic: "discover",
  })
  expect(parseCliArguments(["repair", "-h"])).toEqual({ command: "help", topic: "repair" })
  expect(helpText("discover")).toContain("flakelab discover <test> [options]")
  expect(helpText("discover")).toContain("--fault <family>")
  expect(helpText("doctor")).toContain("flakelab doctor")
  expect(helpText("diagnose")).toContain("<artifacts>/candidate.diff")
  expect(helpText("diagnose")).toContain("<artifacts>/proof.json")
})

test("command help never weakens the existing argument contract", () => {
  expect(parseCliArguments([])).toEqual({ command: "help" })
  expect(parseCliArguments(["--help"])).toEqual({ command: "help" })
  expect(parseCliArguments(["tests/checkout.spec.ts", "--help"])).toEqual({ command: "help" })
  expect(() => parseCliArguments(["scan"])).toThrow("scan requires exactly one target")
  expect(() => parseCliArguments(["discover", "tests/a.spec.ts", "--nope"]))
    .toThrow("Unknown option '--nope'")
})

import type { DocumentRow } from "./ui/document.js"
import { TerminalDocument } from "./ui/document.js"
import type { TerminalTheme } from "./ui/theme.js"
import { PLAIN_THEME } from "./ui/theme.js"

export type HelpTopic =
  | "analyze"
  | "bisect"
  | "diagnose"
  | "discover"
  | "doctor"
  | "investigate"
  | "prove"
  | "repair"
  | "replay"
  | "report"
  | "resume"
  | "scan"

export interface CommandHelp {
  examples: string[]
  options: DocumentRow[]
  summary: string
  usage: string
}

const FAULTS = "animation-speed, auth-cookie-expiry, clock-jump, event-loop-stall, locale,"
  + " network-delay, reduced-motion, resource-loading-delay, response-duplication,"
  + " response-reordering, response-truncation, shared-state-interference,"
  + " startup-event-delay, storage-state-delay, timezone, viewport, worker-pressure"

const FAULT_BOUNDS = "--max-delay, --max-duplicate-bytes, --max-hold-ms, --max-remove-bytes,"
  + " --max-stall-ms, --stall-after-ms, --max-workers, --max-copies, --resource-type,"
  + " --startup-event, --cookie-name, --storage, --storage-key, --clock-offset-ms,"
  + " --jump-after-ms, --locale, --timezone, --viewport-width, --viewport-height,"
  + " --animation-rate"

const EVIDENCE_OPTIONS: DocumentRow[] = [
  {
    label: "--reproducer <path>",
    value: "Minimized reproducer (diagnose defaults beneath --artifacts)",
  },
  { label: "--patch <path>", value: "Candidate diff (default: candidate.diff)" },
  { label: "--proof <path>", value: "Proof matrix (default: flakelab.proof.json)" },
]

const PROVIDER_OPTIONS: DocumentRow[] = [
  { label: "--model <name>", value: "Groq model identifier" },
  { label: "--max-cost <usd>", value: "Model spend ceiling applied before work starts" },
  { label: "--prompt-credentials", value: "Re-enter provider keys through a hidden prompt" },
]

const REPOSITORY_OPTION: DocumentRow = {
  label: "--config <path>",
  value: "Resolve an otherwise ambiguous Playwright configuration",
}

const DISCOVERY_OPTIONS: DocumentRow[] = [
  { label: "--fault <family>", value: FAULTS },
  { label: "--pattern <glob>", value: "Override the automatically observed request target" },
  { label: "--trials <number>", value: "Trials per candidate batch" },
  { label: "--concurrency <n>", value: "Playwright workers per trial batch (default: 2)" },
  { label: "--min-rate <rate>", value: "Failure rate a trigger must reach to be confirmed" },
  { label: "--seed <number>", value: "Deterministic seed for every trial" },
  { label: "--max-seconds <n>", value: "Elapsed-time ceiling for the search (default: 600)" },
  { label: "Fault bounds", value: FAULT_BOUNDS },
]

export const COMMAND_HELP: Record<HelpTopic, CommandHelp> = {
  analyze: {
    examples: [
      "flakelab analyze ./blob-report",
      "flakelab analyze ./playwright-report.zip --baseline previous.json --json",
    ],
    options: [
      { label: "--artifacts <dir>", value: "Evidence directory (default: .flakelab/runs)" },
      { label: "--baseline <artifact>", value: "Rank signatures absent from an earlier artifact" },
      { label: "--json", value: "Write only the analysis artifact JSON to stdout" },
      { label: "--verbose", value: "Append the artifact JSON to the human summary" },
    ],
    summary: "Triage an existing Playwright blob report without rerunning any test.",
    usage: "flakelab analyze <blob-report> [options]",
  },
  bisect: {
    examples: ["flakelab bisect --good v1.4.0 --bad HEAD"],
    options: [
      { label: "--good <revision>", value: "Last revision believed to be healthy (required)" },
      { label: "--bad <revision>", value: "Revision that shows the failure" },
      { label: "--bisect-parallelism <n>", value: "Concurrent Solari sandboxes" },
      { label: "--bisect-report <path>", value: "Where to write the bisect evidence" },
      { label: "--max-trials <number>", value: "Trial ceiling per evaluated revision" },
      { label: "--min-rate <rate>", value: "Failure rate that marks a revision bad" },
      { label: "--reproducer <path>", value: "Reproducer that defines the failure" },
      { label: "--prompt-credentials", value: "Re-enter provider keys through a hidden prompt" },
    ],
    summary: "Locate the commit that introduced a reproducer, in disposable Solari sandboxes.",
    usage: "flakelab bisect --good <revision> [options]",
  },
  diagnose: {
    examples: [
      "flakelab diagnose tests/checkout.spec.ts",
      "flakelab diagnose --report ./blob-report --baseline previous.json",
      "flakelab diagnose tests/checkout.spec.ts --discover",
    ],
    options: [
      REPOSITORY_OPTION,
      { label: "--artifacts <dir>", value: "Default output directory (.flakelab/runs)" },
      { label: "--report <blob-report>", value: "Start from existing evidence instead of a scan" },
      { label: "--runs <number>", value: "Repetitions in the bounded control scan" },
      { label: "--discover", value: "Compare paired controls, then minimize a trigger" },
      { label: "--investigate", value: "Explicitly enable bounded Groq investigation" },
      { label: "--repair", value: "Explicitly enable Groq repair and isolated Solari proof" },
      { label: "--source <file>", value: "Approve one application source file (max 7)" },
      { label: "--evidence <path>", value: "Investigation artifact (default: <artifacts>/investigation.json)" },
      { label: "--reproducer <path>", value: "Reproducer (default: <artifacts>/reproducer.yaml)" },
      { label: "--patch <path>", value: "Candidate diff (default: <artifacts>/candidate.diff)" },
      { label: "--proof <path>", value: "Proof matrix (default: <artifacts>/proof.json)" },
      { label: "--html <path>", value: "Portable report (default: <artifacts>/report.html)" },
      { label: "--open", value: "Open the generated report without prompting" },
      ...PROVIDER_OPTIONS,
      {
        label: "Bounds",
        value: "--trials, --concurrency, --seed, --max-delay, --min-rate, --pattern,"
          + " --max-seconds, --max-steps, --max-experiments, --max-trials",
      },
    ],
    summary: "The primary workflow: observe first, then run only the cheapest useful next step.",
    usage: "flakelab diagnose [test] [options]",
  },
  discover: {
    examples: [
      "flakelab discover tests/checkout.spec.ts --fault network-delay --max-delay 250",
      "flakelab discover tests/payload.spec.ts --fault response-truncation --max-remove-bytes 64",
    ],
    options: [
      REPOSITORY_OPTION,
      ...DISCOVERY_OPTIONS,
      { label: "--output <path>", value: "Reproducer to write (default: flakelab.repro.yaml)" },
    ],
    summary: "Search one fault family for the smallest deterministic trigger, then confirm it.",
    usage: "flakelab discover <test> [options]",
  },
  doctor: {
    examples: ["flakelab doctor"],
    options: [],
    summary: "Check Node, Playwright, Chromium, evidence privacy, and credential safety.",
    usage: "flakelab doctor",
  },
  investigate: {
    examples: ["flakelab investigate tests/checkout.spec.ts --max-cost 0.10"],
    options: [
      { label: "--report <path>", value: "Investigation artifact path" },
      { label: "--max-steps <number>", value: "Agent reasoning steps (default: 4)" },
      { label: "--max-experiments <n>", value: "Experiments the agent may run" },
      { label: "--max-trials <number>", value: "Trial ceiling across the investigation" },
      { label: "--max-seconds <number>", value: "Elapsed-time ceiling" },
      ...PROVIDER_OPTIONS,
      {
        label: "Bounds",
        value: "--trials, --concurrency, --max-delay, --min-rate, --pattern, --seed",
      },
    ],
    summary: "Run the bounded Groq investigator over compact, redacted experiment results.",
    usage: "flakelab investigate <test> [options]",
  },
  prove: {
    examples: [
      "flakelab prove tests/checkout.spec.ts",
      "flakelab tests/checkout.spec.ts --prove --fault viewport --viewport-width 390",
    ],
    options: [
      REPOSITORY_OPTION,
      ...DISCOVERY_OPTIONS,
      { label: "--source <file>", value: "Approve one application source file (max 7)" },
      { label: "--html <path>", value: "Portable evidence report path" },
      { label: "--open", value: "Open the generated report without prompting" },
      { label: "--publish", value: "Publish the redacted report after confirmation" },
      ...EVIDENCE_OPTIONS,
      ...PROVIDER_OPTIONS,
    ],
    summary: "Run discover, replay, investigate, repair, and report as one proof pipeline.",
    usage: "flakelab prove <test> [options]",
  },
  repair: {
    examples: ["flakelab repair flakelab.investigation.json --source src/checkout.ts"],
    options: [
      { label: "--source <file>", value: "Approve one application source file (repeatable)" },
      { label: "--concurrency <n>", value: "Independent proof processes (default: 1; avoids shared web-server ports)" },
      { label: "--max-seconds <number>", value: "Elapsed-time ceiling for candidate generation" },
      ...EVIDENCE_OPTIONS,
      ...PROVIDER_OPTIONS,
    ],
    summary: "Generate one policy-bounded candidate and prove it in a disposable Solari microVM.",
    usage: "flakelab repair <investigation> [options]",
  },
  replay: {
    examples: ["flakelab replay flakelab.repro.yaml --concurrency 4"],
    options: [
      { label: "--concurrency <n>", value: "Playwright workers used for replay trials (default: 2)" },
    ],
    summary: "Re-run a saved reproducer and check that the recorded signature still appears.",
    usage: "flakelab replay <reproducer> [options]",
  },
  report: {
    examples: ["flakelab report flakelab.investigation.json --open"],
    options: [
      { label: "--html <path>", value: "Output file (default: flakelab.report.html)" },
      { label: "--open", value: "Open the generated report without prompting" },
      { label: "--publish", value: "Publish the redacted report after confirmation" },
      ...EVIDENCE_OPTIONS,
      { label: "--prompt-credentials", value: "Re-enter provider keys through a hidden prompt" },
    ],
    summary: "Bundle validated evidence into one portable, offline HTML report.",
    usage: "flakelab report <investigation> [options]",
  },
  resume: {
    examples: ["flakelab resume .flakelab/runs/diagnose.json"],
    options: [],
    summary: "Continue a checkpointed diagnosis at the next safe phase, without repeating work.",
    usage: "flakelab resume <diagnose.json>",
  },
  scan: {
    examples: [
      "flakelab tests/checkout.spec.ts --runs 20",
      "flakelab scan tests/checkout.spec.ts --json",
    ],
    options: [
      REPOSITORY_OPTION,
      { label: "--runs <number>", value: "Repetitions to run (default: 4)" },
      { label: "--concurrency <n>", value: "Playwright workers (default: 2)" },
      { label: "--artifacts <dir>", value: "Evidence directory (default: .flakelab/runs)" },
      { label: "--json", value: "Write only the scan artifact JSON to stdout" },
      { label: "--verbose", value: "Append the artifact JSON to the human summary" },
    ],
    summary: "Repeat a Playwright target under normal conditions and classify what happens.",
    usage: "flakelab scan <target> [options]",
  },
}

export function commandHelpText(topic: HelpTopic, theme: TerminalTheme = PLAIN_THEME): string {
  const help = COMMAND_HELP[topic]
  const document = new TerminalDocument(theme)
  document.heading(topic)
  document.blank().text(help.summary)
  document.section("Usage").command(help.usage)
  if (help.options.length > 0) {
    document.section("Options").rows(help.options)
  }
  document.section("Examples")
  for (const example of help.examples) {
    document.command(example)
  }
  document.section("More").command("flakelab --help")
  return `${document.render()}\n`
}

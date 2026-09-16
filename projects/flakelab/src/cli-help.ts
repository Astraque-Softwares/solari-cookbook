import { readFileSync } from "node:fs";

import type { HelpTopic } from "./cli-command-help.js";
import { commandHelpText } from "./cli-command-help.js";
import type { DocumentRow } from "./ui/document.js";
import { labelColumn, TerminalDocument } from "./ui/document.js";
import type { TerminalTheme } from "./ui/theme.js";
import { PLAIN_THEME } from "./ui/theme.js";

function packageVersion(): string {
  const manifest = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  const match = /"version"\s*:\s*"([^"]+)"/u.exec(manifest);
  if (!match?.[1]) {
    throw new Error("FlakeLab package version is missing");
  }
  return match[1];
}

export const VERSION = packageVersion();

const DOCUMENTATION =
  "https://github.com/kelvinguchu/solari-cookbook/tree/main/projects/flakelab";

interface HelpGroup {
  rows: DocumentRow[];
  title: string;
}

const COMMAND_GROUPS: HelpGroup[] = [
  {
    rows: [
      { label: "scan <target>", value: "Run a bounded stability scan" },
      {
        label: "analyze <blob-report>",
        value: "Triage an existing Playwright blob report",
      },
      { label: "doctor", value: "Check local readiness and credential safety" },
    ],
    title: "Observe",
  },
  {
    rows: [
      {
        label: "diagnose [test]",
        value: "Explain evidence and run the next bounded step",
      },
      {
        label: "discover <test>",
        value: "Minimize a reproducible causal fault",
      },
      { label: "replay <reproducer>", value: "Verify a saved reproducer" },
      {
        label: "resume <diagnose.json>",
        value: "Continue a checkpointed diagnosis",
      },
    ],
    title: "Reproduce",
  },
  {
    rows: [
      {
        label: "investigate <test>",
        value: "Run the bounded Groq investigator",
      },
      {
        label: "repair <investigation>",
        value: "Prove a candidate repair in Solari",
      },
      {
        label: "prove <test>",
        value: "Run discover, investigate, repair, and report",
      },
      {
        label: "report <investigation>",
        value: "Build the portable evidence report",
      },
      {
        label: "bisect --good <rev>",
        value: "Locate the introducing commit in Solari",
      },
    ],
    title: "Explain and prove",
  },
];

const WORKFLOWS: DocumentRow[] = [
  {
    label: "Measure stability",
    value: "flakelab tests/checkout.spec.ts --runs 20",
  },
  { label: "Triage CI evidence", value: "flakelab analyze ./blob-report" },
  {
    label: "Find a trigger",
    value: "flakelab diagnose tests/checkout.spec.ts --discover",
  },
  { label: "Prove a fix", value: "flakelab prove tests/checkout.spec.ts" },
];

const EXIT_CODES: DocumentRow[] = [
  { label: "0", value: "No failure observed" },
  {
    label: "1",
    value: "Mixed outcomes, failure in every run, or command error",
  },
  {
    label: "2",
    value: "Inconclusive scan caused by test or Playwright infrastructure",
  },
];

const CREDENTIALS: DocumentRow[] = [
  { label: "GROQ_API_KEY", value: "investigate, repair, prove" },
  { label: "SOLARI_API_KEY", value: "repair, bisect, publish, prove" },
];

function appendCommands(document: TerminalDocument): void {
  const column = labelColumn(COMMAND_GROUPS.flatMap((group) => group.rows));
  for (const group of COMMAND_GROUPS) {
    document.section(group.title).rows(group.rows, column);
  }
}

export function mainHelpText(theme: TerminalTheme = PLAIN_THEME): string {
  const document = new TerminalDocument(theme);
  document.banner(
    `FlakeLab ${VERSION} - find and prove flaky Playwright tests`,
  );
  document.section("Usage");
  document.command("flakelab <target> [scan options]");
  document.command("flakelab <command> [command options]");
  appendCommands(document);
  document.section("Common workflows").rows(WORKFLOWS);
  document.section("Exit codes").rows(EXIT_CODES);
  document.section("Credentials").rows(CREDENTIALS);
  document.note(
    "Missing keys are requested through hidden, run-once terminal prompts and are never" +
      " passed to Playwright test processes.",
  );
  document.section("More");
  document.command("flakelab <command> --help");
  document.note(DOCUMENTATION);
  return `${document.render()}\n`;
}

export function helpText(
  topic?: HelpTopic,
  theme: TerminalTheme = PLAIN_THEME,
): string {
  return topic ? commandHelpText(topic, theme) : mainHelpText(theme);
}

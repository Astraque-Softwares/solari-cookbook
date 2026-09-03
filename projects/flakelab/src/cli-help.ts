export const VERSION = "0.1.0"

export function helpText(): string {
  return `FlakeLab ${VERSION} — find and prove flaky Playwright tests

Usage
  flakelab <path> [options]
  flakelab <command> <target> [options]

Easiest run
  npx flakelab@latest .

Common examples
  npx flakelab@latest tests/checkout.spec.ts --runs 20
  npx flakelab@latest tests/checkout.spec.ts --verbose
  npx flakelab@latest tests/checkout.spec.ts --prove --pattern "**/api/checkout"

Default scan options
  --runs <number>          Repetitions to run (default: 4)
  --concurrency <number>   Parallel test processes (default: 4)
  --seed <number>          Deterministic seed (default: 1)
  --artifacts <directory>  Evidence directory (default: .flakelab/runs)
  --verbose                Include machine-readable evidence
  --prove                  Run discovery, AI investigation, isolated repair, and report
  --open                   Open the generated report

Advanced commands
  diagnose <test>          Compare control and network-delay trials
  discover <test>          Minimize a reproducible network trigger
  replay <reproducer>      Verify a saved reproducer
  investigate <test>       Run the bounded Groq investigator
  repair <investigation>   Prove a candidate repair in Solari
  report <investigation>   Build the portable evidence report
  bisect --good <revision> Locate the introducing commit in Solari

Environment
  GROQ_API_KEY             Required for investigate, repair, and --prove
  SOLARI_API_KEY           Required for repair, bisect, publish, and --prove

Detailed command documentation
https://github.com/kelvinguchu/solari-cookbook/tree/main/projects/flakelab
`
}

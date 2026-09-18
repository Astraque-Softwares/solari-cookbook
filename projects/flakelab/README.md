# FlakeLab

FlakeLab is an AI debugging scientist for flaky Playwright tests. The product architecture,
scope, and milestone-based development plan live in
[`../../FLAKELAB.md`](../../FLAKELAB.md).

## Quick start

Run a bounded, local, credit-free stability scan from any Playwright project:

```bash
npx flakelab@latest .
```

Pass a file when you already know which test is suspicious, and increase repetitions when the
failure is rare:

```bash
npx flakelab@latest tests/checkout.spec.ts --runs 20
npx flakelab@latest tests/checkout.spec.ts --runs 20 --verbose
npx flakelab@latest scan tests/checkout.spec.ts --runs 20 --json
```

For an end-to-end demonstration in a real monorepo, use the
[FlakeLab Actual Budget demo](https://github.com/kelvinguchu/flakelab-actual-budget-demo).
It is an explicitly labelled, intentionally timing-sensitive fork of Actual Budget with a
meaningful onboarding test and a fixable application-source defect. Its
[walkthrough](https://github.com/kelvinguchu/flakelab-actual-budget-demo/blob/main/packages/docs/docs/contributing/flakelab-demo.md)
covers cloning, installation, the Windows and macOS/Linux terminal setup, provider credentials,
diagnosis, candidate generation, and Solari proof.

The default command starts one Playwright process and uses Playwright's native `--repeat-each`
and JSON reporter to classify every selected test as `no-failure-observed`, `mixed-outcomes`,
`failed-every-run`, `skipped`, or `errored`. These labels describe only the bounded sample; they
do not claim that a test is permanently stable. The human summary includes the 80% Wilson
confidence interval-or the upper bound when no failure was observed-and writes machine-readable evidence to
`.flakelab/runs/scan.json`. The artifact contains direct run totals, per-test identities,
confidence bounds, and bounded failure-signature clusters. Each cluster records its observed
rate, first and last attempt, a redacted representative reason, and up to three representative
trace, screenshot, or video paths. Multiple independent failure modes are called out explicitly.
The scan does not call
Groq or Solari. Use `--json` when another tool needs the scan artifact on stdout; progress remains
on stderr so the JSON stream stays parseable. A scan exits `0` when it observes no failure, `1`
when it observes mixed outcomes or failure in every run, and `2` when infrastructure makes the
result inconclusive.

For a large target, the terminal summary lists problematic tests first and collapses clean
observations into a count. The saved artifact, `--json`, and `--verbose` retain every test record.

Paths stored in scan evidence are relative to the scanned project. Outside-project paths are
reduced to a non-identifying placeholder and basename, and the JSON does not record its own output
location. Playwright directories containing only `.last-run.json` are removed after the scan.
Evidence-bearing directories receive a FlakeLab ownership marker and only the five newest are
retained; unmarked directories are always treated as user-owned and are never removed.

Every scan target is deliberate: `flakelab .` is the shortest whole-project form, while the
spelled-out `flakelab scan` command requires its target and never silently substitutes `.`.

## Proof in other repositories

Run FlakeLab from the package containing your Playwright configuration. Remote proof no longer
requires FlakeLab's own `src`, `tests`, TypeScript configuration, or pnpm scripts. It copies the
target workspace, preserves monorepo siblings, installs dependencies at the workspace root,
and runs the proof from the selected package. The proof runner is installed separately from
the application and uses the target's Playwright installation and browsers.

The package manager comes from `packageManager`, then the lockfile (npm, pnpm, Yarn, or Bun).
Pin `packageManager` to an exact version for repeatable setup. Existing lockfiles use frozen
installation. Yarn installs use the `node-modules` linker for the isolated proof workspace.
Configured `typecheck` and `lint` scripts run from the selected package, falling back to root
scripts. Missing checks are reported as **not configured**, not as passed or failed.

For application-specific preparation, declare existing package scripts in the selected
package's `package.json`; these run in order after dependency installation:

```json
{
  "flakelab": {
    "proof": {
      "node": "22",
      "setup": ["build:browser"]
    }
  }
}
```

Node defaults to 22; `node` accepts a major or an exact version. Setup is optional, and
FlakeLab does not guess a build command. Use Playwright's `webServer` configuration to manage
the application server. Databases, private registries, and external services still require
explicit project setup; this is not a promise that every repository runs without configuration.
Provider keys and local environment variables are not forwarded to the remote application.

Git projects copy tracked and non-ignored untracked files; non-Git projects are also supported.
Dependencies, known credential files, and FlakeLab/test artifacts are excluded. Yarn configs
containing authentication settings are rejected, as are symlinks. Snapshots are bounded to
20,000 files and 100 MiB, and temporary copies are removed after proof, including on failure.

## Analyze an existing CI failure

Point FlakeLab at a Playwright blob-report archive or a directory of shard archives:

```bash
npx flakelab@latest analyze ./blob-report
npx flakelab@latest analyze ./blob-report --baseline .flakelab/runs/analyze.json --json
```

Analysis does not rerun tests and needs no provider credentials. FlakeLab copies and validates
the archives inside an owned working directory, asks Playwright's supported report merger for
the canonical JSON report, and leaves the source reports untouched. Unsafe paths, links,
malformed ZIP structures, excessive expansion, and unbounded archive sets are rejected before
the merger runs.

The terminal summary ranks mixed outcomes, recurring failures, diagnostic attachments, and
failure modes not present in the optional baseline. The complete result is written to
`.flakelab/runs/analyze.json`; `--json` emits the same validated artifact on stdout. Referenced
traces, screenshots, and videos are retained with the owned analysis evidence under bounded
retention, while temporary archive copies and conversion files are removed.

The scan explicitly disables Playwright retries so a retry is never mistaken for an independent
statistical repetition. It uses two Playwright workers by default for a practical speed/isolation
balance. Use `--concurrency 1` when a suite shares ports, databases, caches, or workspace files
unsafely. Traces, screenshots, videos,
and ordinary test output stay in a unique directory beneath the selected evidence directory;
FlakeLab removes only its temporary JSON reporter file.

The native JSON reporter contract is tested against `@playwright/test` 1.62.1, which is the current
peer requirement. The integration fixture covers repetitions, multiple projects, expected
failures, skips, timeouts, file-backed attachments, and paths containing spaces.

The causal workflow works with ordinary Playwright tests. Keep importing `test` and `expect` from
`@playwright/test`; no per-test FlakeLab fixture or source edit is required. For each experiment,
FlakeLab creates a temporary config beside the existing Playwright config, retains its projects,
dependencies, web server, authentication settings, application environment, and reporters, and
adds a local fault proxy through Playwright's public configuration. The generated config and proxy
are removed after the trial, including after failure or interruption. The current project-level
bridge injects matching HTTP requests; it reports an explicit unsupported-path error instead of
claiming success when a selected route is HTTPS or no request matches.

Then explicitly opt into AI investigation and isolated proof:

```bash
npx flakelab@latest prove tests/checkout.spec.ts \
  --fault network-delay \
  --pattern "**/api/checkout" \
  --open
```

The equivalent target shortcut is `npx flakelab@latest tests/checkout.spec.ts --prove`.
Proof mode requires `GROQ_API_KEY` and `SOLARI_API_KEY`. It chains trigger discovery, reproducer
verification, bounded AI investigation, candidate generation, proof in a disposable Solari
microVM, and the offline evidence report. The candidate remains a reviewable diff and is never
applied automatically.

Pass `--reproducer <path>` to use a custom reproducer location throughout discovery, replay,
investigation, repair, and reporting. The combined `prove` command does not accept a separate
`--output` path.

See every command and its accepted options without running tests:

```bash
npx flakelab@latest --help
```

Check whether the current project is ready without running tests or consuming provider credits:

```bash
npx flakelab@latest doctor
```

The doctor checks Node.js, Playwright configuration, Chromium, ignored evidence output,
credential availability, and test-process credential isolation. It reports only whether a
credential is configured and where it came from; it never prints the value or a fingerprint.

Use `diagnose` as the adaptive product journey. A target begins with the bounded native scan;
an existing CI report begins with read-only analysis:

```bash
npx flakelab@latest diagnose tests/checkout.spec.ts
npx flakelab@latest diagnose --report ./blob-report
```

The command explains what was observed and keeps its default outputs together under
`.flakelab/runs`: the diagnosis checkpoint, scan and discovery evidence, reproducer,
investigation, candidate diff, proof matrix, and HTML report. `--artifacts <path>` moves that
default set as a unit, while the individual output options remain available as explicit
overrides. The checkpoint records the cheapest useful next experiment, its trial bound, an
expected duration based on the local scan when available, required credentials, and the Solari
estimate-or an explicit statement that no reliable estimate is available. Local diagnosis never
requests provider credentials.

Continue only as far as the evidence justifies:

```bash
npx flakelab@latest diagnose tests/checkout.spec.ts --discover
npx flakelab@latest diagnose tests/checkout.spec.ts --investigate
npx flakelab@latest diagnose tests/checkout.spec.ts --repair
```

`--discover` remains local. Automatic discovery builds a capability plan from the resolved test,
observed request route, and repeated scan. It runs one sequential exploratory probe for each
applicable, not-yet-covered fault family and stops immediately when a signal appears. Only that
signal continues to matched control/intervention confirmation at 4, 6, and at most 8 pairs. The
whole discovery phase has a hard 28-execution ceiling. If every probe is clean, the diagnosis
completes as `no-signal-observed`, retains
the screened, covered, and inapplicable families with reasons in its discovery sidecar, and does
not request provider credentials or invent a reproducer. `--investigate` explicitly enables
bounded Groq usage and retains both the reproducer and investigation evidence. `--repair`
explicitly enables candidate generation and a disposable Solari proof; a rejected candidate still
produces the portable evidence report. When starting from `--report`, supply a test target before
requesting new experiments so FlakeLab never guesses which test to execute.

Every diagnosis writes `diagnose.json` atomically after each completed phase and when work fails
or is interrupted. Continue the exact saved workflow with:

```bash
npx flakelab@latest resume .flakelab/runs/diagnose.json
```

Resume validates the checkpoint and its original input hash, confines saved paths to the current
project, and starts at the next safe phase. It does not repeat a confirmed scan, discovery, or
investigation. Completed checkpoints are a no-op apart from printing their summary. Partial
checkpoints remain readable and are labelled `running`, `interrupted`, or `failed`; they never
masquerade as a completed result.

The checkpoint shows planned and actual trial counts, wall time, AI token usage and estimated
cost, Solari sandbox creation and release counts, snapshot-cache decisions, and cleanup status.
It stores normalized options and project-relative artifact paths, not credentials. `Ctrl+C` stops
new trials; local Playwright process trees and disposable remote resources are cleaned up by the
same bounded execution paths used outside diagnosis.

Prepared Solari demo snapshots are reused only when a key covering the commit, lockfile, fixture,
template, runtime command, application path, port, and timeout matches. The metrics artifact gives
the key and a reason for every hit or miss. Candidate repair workspaces are intentionally not
cached because each contains a unique patch; their checkpoint explains that decision.

## Discover and replay a robust reproducer

Run matched control and fault trials, then confirm a robust configured fault using a sequential
causal gate:

```bash
pnpm flakelab discover tests/fixtures/flaky-checkout.spec.ts \
  --fault network-delay \
  --trials 4 \
  --concurrency 1 \
  --seed 42 \
  --max-delay 125 \
  --max-seconds 300 \
  --min-rate 0.7 \
  --output flakelab.repro.yaml
```

The command writes a strict portable YAML reproducer and a JSON discovery sidecar containing the
evidence. Control and intervention trials share seeds and both traverse the same proxy path; the
control proxy performs no mutation. A pre-existing failure is allowed, but the intervention is
causal only when the same normalized failure signature is dominant, reaches the practical failure
rate, keeps the control rate low, and passes the one-sided Fisher exact gate. FlakeLab evaluates
after 4, 6, and at most 8 pairs and stops as soon as the result is decisive. Wilson intervals remain
in the artifact as descriptive uncertainty, not the causal acceptance rule. Discovery also stops
at the 28-execution or elapsed-time ceiling, whichever arrives first. Set `--max-seconds`
explicitly when a suite needs a different local budget. Replay the result with:

```bash
pnpm flakelab replay flakelab.repro.yaml --concurrency 1
```

The current project-level fault matrix supports deterministic network delay, type-aware resource
loading delay, injected HTTP failures, response truncation, response-tail duplication, and response
reordering. Probe malformed payload handling with
`--fault response-truncation --max-remove-bytes 1024` or
`--fault response-duplication --max-duplicate-bytes 1024`. Find request races with
`--fault response-reordering --max-hold-ms 250`; the first response in each adjacent matching pair
is held while the second proceeds. Response mutations run in the order stored in the bounded fault
set, so a reproducer can express and replay an exact composition without introducing another schema.
Isolate startup dependencies with
`--fault resource-loading-delay --resource-type script --pattern "**/assets/*" --max-delay 250`.
Resource loading can target `document`, `script`, `stylesheet`, `image`, or `font` without slowing
unrelated API traffic. Discovery saves the confirmed configured value instead of searching for a
fragile one-unit boundary, so the portable reproducer remains useful across ordinary machine
jitter.
Delay application lifecycle listeners independently with
`--fault startup-event-delay --startup-event dom-content-loaded --pattern "**/checkout"`.
The fault supports `dom-content-loaded` and `load`, injects a temporary same-origin bootstrap into
matching HTML, preserves an existing script nonce, and verifies that the bootstrap actually ran.
It delays application listeners rather than the browser lifecycle event itself, network traffic,
or the event loop.
Probe missed main-thread deadlines with
`--fault event-loop-stall --max-stall-ms 500 --stall-after-ms 0 --pattern "**/checkout"`.
The offset is measured from the native `DOMContentLoaded` event and the stall duration is bounded
at two seconds. Discovery confirms the configured duration with matched pairs and saves it as the
reproducer. The fault blocks only the matching page's main thread;
it does not simulate system-wide CPU saturation.
Test expired session handling without recording credentials with
`--fault auth-cookie-expiry --cookie-name session-id --pattern "**/api/session"`.
Only the named cookie is withheld from matched requests, and an absent cookie is reported as an
unapplied fault rather than false causal evidence. Reproducers contain the cookie name but never
its value. The direct browser adapter restores the original cookie in `finally`.
Test partially initialized browser state with
`--fault storage-state-delay --storage local-storage --storage-key auth-token --max-delay 500`
and a document URL pattern. The bootstrap temporarily makes `getItem` return `null` only for that
key; it does not delete or record the stored value. Both local and session storage are supported,
and discovery confirms the configured visibility delay before saving the trigger.
Expose wall-clock assumptions with
`--fault clock-jump --clock-offset-ms 3600000 --jump-after-ms 25 --pattern "**/app"`.
The fault changes `Date` wall time after a deterministic offset while leaving `performance.now`,
timeouts, and interval scheduling monotonic. Use `--clock-offset-ms=-3600000` for a backward jump.
Exercise internationalization assumptions with
`--fault locale --locale fr-FR --pattern "**/app"` or
`--fault timezone --timezone America/New_York --pattern "**/app"`. Locale tags and IANA timezone
names are validated before trials. These two settings are applied through Playwright's browser
context configuration; the document pattern verifies that the intended target was reached. The
direct page adapter rejects them explicitly because an existing Playwright context cannot be
reconfigured faithfully after creation.
Probe responsive and accessibility-specific behavior with
`--fault viewport --viewport-width 375 --viewport-height 667` and
`--fault reduced-motion`. Viewports are bounded from 200 to 7680 pixels in each dimension, and
reduced motion uses the browser's native media emulation. Test animation races with
`--fault animation-speed --animation-rate 5`; rates are bounded from 0.1x to 10x and alter Web
Animations and CSS animation/transition playback without accelerating application timers. Each
visual fault is reversible, uses a paired control, and requires a matched document before FlakeLab
accepts its causal evidence.
Expose suite-level isolation bugs with
`--fault worker-pressure --max-workers 4`. FlakeLab raises Playwright's supported worker limit,
enables full parallel scheduling for the selected target, and confirms the configured worker count.
Probe shared accounts, records, ports, and other cross-test state with
`--fault shared-state-interference --max-copies 4`; this overlaps repeated copies of the selected
test through Playwright's supported `repeatEach` and worker controls. Both faults use matched-seed
single-worker controls, are bounded to 16 workers or copies, and use the same sequential 4/6/8-pair
causal gate. They store the selected test path-not a URL glob-as their artifact target.
The local proxy and generated Playwright config are removed after every trial, including failed and
interrupted tests. Solari repair proof consumes the same validated fault set as local replay.
Revision bisect still rejects unsupported fault combinations explicitly rather than approximating
remote behavior.

## AI investigator

Run the investigator directly. If `GROQ_API_KEY` is not already configured, an interactive
terminal requests it through hidden input and keeps it in memory for this run only:

```bash
pnpm flakelab investigate tests/fixtures/flaky-checkout.spec.ts \
  --trials 4 \
  --concurrency 1 \
  --max-delay 125
```

The investigator uses the provider-neutral [Vercel AI SDK](https://ai-sdk.dev/docs/agents/overview)
with Groq's [`qwen/qwen3.8-27b`](https://console.groq.com/docs/model/qwen/qwen3.8-27b)
model. It makes two bounded model calls: one to propose competing hypotheses and a three-part
experiment batch, and one to assess the resulting evidence. FlakeLab-not the model-executes
trials, calculates confidence, enforces budgets, and decides whether a causal claim is valid.

The model receives only the selected test and at most eight local imported source files through
a 64 KiB, path-confined, credential-blocking reader. The resulting evidence-backed report is
written to `flakelab.investigation.json`. If no model key is configured, deterministic
`diagnose`, `discover`, and `replay` commands continue to work.

## Bring your own credentials

FlakeLab connects directly from the developer's machine or CI runner to Groq and Solari. It does
not operate a credential relay or store provider keys in evidence. Credential lookup follows this
order:

1. the current process environment, including protected CI environment secrets;
2. a local `.env` file for compatibility with existing workflows;
3. hidden interactive input, retained in memory only until the FlakeLab process exits.

Do not put credentials in command arguments: shell history and process inspection can expose
them. FlakeLab deliberately has no `--api-key` option. Local `.env` files and `.flakelab` evidence
are ignored by this repository, but protected CI secrets or the hidden run-once prompt are the
preferred choices.

Groq and Solari credentials are removed from the environment passed to Playwright subprocesses.
Application-specific environment variables remain available so existing test suites continue to
work. Provider keys are used only by the FlakeLab process at the API boundary and are never
injected into disposable proof sandboxes.

The complete AI investigation, candidate generation, and isolated proof journey needs both
`GROQ_API_KEY` and `SOLARI_API_KEY`. Local scan, analysis, discovery, replay, and offline report
generation need neither. For secure PowerShell, Bash/zsh, `.env`, and CI examples, see the
[provider credential guide](../../docs/content/docs/credentials.mdx).

To ignore an outdated shell or `.env` credential and enter replacements securely for one run:

```bash
npx flakelab@latest . --prove --prompt-credentials
```

FlakeLab requests each required key once, hides terminal input, and reuses it only inside that
process. It does not modify the shell, `.env`, or CI configuration.

Provider failures are normalized from typed SDK errors, HTTP status, and machine-readable error
codes. Authentication, permissions, billing, rate limits, concurrency caps, capacity, network,
timeouts, and invalid requests receive separate next actions. FlakeLab does not branch on provider
prose or print raw response bodies. Groq rate and capacity failures may be retried within the
configured bound; Solari concurrency `429` responses are not retried because a session must be
released before another can start.

## Isolated candidate repair

After reviewing an investigation, generate and prove a candidate without changing the working
tree:

```bash
pnpm flakelab repair flakelab.investigation.json \
  --reproducer flakelab.repro.yaml \
  --source src/checkout.ts \
  --max-cost 0.25 \
  --patch candidate.diff \
  --proof flakelab.proof.json
```

This command requires both `GROQ_API_KEY` and `SOLARI_API_KEY`. `--max-cost` bounds candidate
generation, and the result reports observed model tokens and estimated cost. Repeat `--source` to
approve up to seven application source files that a black-box Playwright test does not import.
Every approved file remains project-confined, JavaScript/TypeScript-only, credential-blocked, and
inside the shared 64 KiB context limit. The model can propose only exact, bounded edits to source it
received. FlakeLab rejects test changes,
assertion weakening, lint suppressions, credential-like additions, path escapes, and numeric-only
timeout increases before execution.

The candidate diff is rendered in an interactive terminal and saved to `candidate.diff` before
proof begins, without changing the working tree. The candidate is then copied into a disposable
Solari microVM. Typecheck, lint, hostile trials, clean
controls, and up to 50 nested or co-located `.spec.*` and `.test.*` regression files all run there.
The machine is destroyed afterward, and the
candidate is returned as a reviewable diff; FlakeLab never applies it to the local checkout.
Cold validation installs the pinned Node/pnpm toolchain and Chromium, so it is intentionally
slower than the future snapshot-backed warm path.

While an interactive stage is waiting on Playwright, Groq, or Solari, FlakeLab prints a small
`working...` pulse. Redirected output and CI logs remain static, and machine-readable stdout is
unchanged.

## Evidence report

Turn the validated investigation, reproducer, candidate, and proof into one portable report:

```bash
pnpm flakelab report flakelab.investigation.json \
  --reproducer flakelab.repro.yaml \
  --proof flakelab.proof.json \
  --patch candidate.diff \
  --html flakelab.report.html \
  --open
```

The React/Recharts interface is bundled by Vite into a single HTML file. It explains the root
cause, deterministic ownership classification, experiment timeline, competing hypotheses,
minimal trigger, before/after proof matrix, static checks, model usage, and reviewable artifacts.
Each causal conclusion links to both its intervention and clean control. Investigation mode retains
project-relative Playwright traces, compares one representative passing control with one failing
intervention, and links each recording from its experiment. The report also gives an exact replay
command, the bounded source files shown to the investigator, and the line of every candidate edit.
The evidence is schema-validated and credential-redacted before rendering. A restrictive content
security policy blocks runtime network access, unsafe evidence links are rejected, and the report
remains usable offline.

Interactive report generation offers to open the local file in the default browser. `--open`
accepts that choice without prompting, while CI and redirected sessions never prompt or open a
browser implicitly. `--publish` is optional and always asks for interactive confirmation
immediately before creating a public Solari preview. Published reports expire and their hosting
sandbox is automatically killed after at most 60 minutes.

## Statistical Git bisect

After producing a deterministic reproducer, locate the introducing commit without executing
historical code on the developer machine:

```bash
pnpm flakelab bisect \
  --good v1.4.0 \
  --bad HEAD \
  --reproducer flakelab.repro.yaml \
  --bisect-report flakelab.bisect.json
```

The selected good revision must be an ancestor of the bad revision, and both endpoints are
measured rather than trusted by name. FlakeLab archives each candidate without Git credentials,
prepares up to two midpoint revisions concurrently in disposable Solari sandboxes, and runs each
probabilistic trial in an independent fork of that revision's snapshot.

Classification uses both sides of an 80% Wilson interval. A revision is bad only when the lower
bound reaches `--min-rate`; it is good only when the upper bound stays below that threshold.
Ambiguous evidence receives another trial batch up to `--max-trials`. Dependency installation or
test-discovery failures are recorded as incompatible instead of being counted as test failures.

The JSON report contains every evaluated commit, pass/fail/error counts, confidence bounds,
snapshot reuse, duration, and decision reason. `firstFailingCommit` is populated only when the
good/bad boundary is exact. If an incompatible or inconclusive commit hides the boundary, the CLI
reports `earliestKnownBadCommit`, exits with code 2, and does not overclaim an exact answer.

Run the explicit credit-consuming end-to-end demonstration with:

```bash
pnpm verify:bisect
```

It creates a temporary four-commit repository with one intentional hydration regression, bisects
it in Solari, writes `.flakelab/bisect-demo.json`, and removes its sandboxes, snapshots, and local
temporary history. It is separate from the default test suite.

## GitHub Actions

The repository includes a reusable composite action and a pull-request workflow:

- `../../.github/actions/flakelab/action.yml` installs the pinned Node/pnpm/Chromium toolchain,
  selects changed tests, diagnoses one bounded target, uploads all evidence, and writes the job
  summary.
- `../../.github/workflows/flakelab.yml` runs the credit-free quality gate on every matching pull
  request and gates provider-backed diagnosis behind the protected `flakelab` environment.

Configure `GROQ_API_KEY` and `SOLARI_API_KEY` as GitHub environment secrets, then add required
reviewers to the `flakelab` environment. Fork pull requests never receive those secrets, checkout
credentials are not persisted, and the workflow deliberately avoids `pull_request_target`.

Changed-test selection prefers directly modified Playwright specs. When application, support,
Playwright configuration, manifest, or lockfile behavior changes, it falls back to the bounded
`tests/e2e` and `tests/fixtures` suite. The current action deeply diagnoses the first selected test
to keep time and cost predictable; `.flakelab/changed-tests.json` preserves the complete selection.

The uploaded artifact is retained for seven days and includes the offline HTML report,
investigation traces, reproducer, discovery evidence, proof, candidate diff, and selection manifest.
A rejected repair still uploads its evidence before the job reports failure.

The same composite action can analyze an existing Playwright blob report without Groq or Solari
credentials. Pass `blob-report` and, optionally, an artifact downloaded from an earlier run as
`baseline`. The action does not rerun tests in this mode; it merges shards, ranks failures, marks
signatures absent from the baseline, uploads the validated analysis, and writes a concise Markdown
job summary. No hosted database is required.

## Parallel Solari runner

Run the live eight-worker verification explicitly so routine tests remain local and
credit-free:

```bash
pnpm verify:solari-parallel
```

For a sequential comparison:

```bash
pnpm verify:solari-parallel -- --concurrency 1 --runs 8
```

The runner prepares and snapshots the application once, reuses snapshots by a cache key
derived from the Git commit, pnpm lockfile, and fixture configuration, and shares one
application sandbox for browser-only faults. Each trial receives an independent Solari
browser session. Metrics include wall time, cumulative trial time, peak concurrency,
infrastructure retries, cache status, and created/released resource counts.

## Live Solari verification

The Solari verification script proves the remote execution path:

1. create a Solari sandbox;
2. write and start a tiny test application;
3. expose it through a preview URL;
4. snapshot the running sandbox and fork a second sandbox from it;
5. launch a recorded Solari browser against the fork;
6. inject network latency and verify the application still reaches its ready state;
7. save a Playwright trace as the guaranteed diagnostic artifact;
8. retrieve the optional Solari rrweb replay when available;
9. destroy both sandboxes, even when a step fails.

## Verify Solari

Set `SOLARI_API_KEY` in your shell, or add it to this directory's `.env` file:

```text
SOLARI_API_KEY=...
```

Then run the explicit live check:

```bash
pnpm install
pnpm verify:solari
```

The command exits non-zero if any required capability is not proven. It never prints the API key.

## Development quality gates

```bash
pnpm typecheck
pnpm lint
pnpm test
```

Run `pnpm quality` before handing back a completed behavior change. The default Playwright suite
is local and credit-free; `repair`, `pnpm verify:solari`, and `pnpm verify:solari-parallel` are
explicit live integrations that can consume Solari credits. `pnpm verify:bisect` is also an
explicit live integration.

## Solari documentation

- [Sandboxes](https://docs.getsolari.com/sandboxes)
- [Snapshots](https://docs.getsolari.com/snapshots)
- [Browser sessions](https://docs.getsolari.com/sessions)
- [Session recording](https://docs.getsolari.com/recording)
- [Browser API reference](https://docs.getsolari.com/api-reference/browser)

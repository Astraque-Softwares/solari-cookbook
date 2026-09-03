# FlakeLab

> An AI debugging scientist for flaky browser tests.

FlakeLab does not merely report that a Playwright test is flaky. It runs controlled
experiments in parallel Solari environments, discovers the condition that makes the
test fail, reduces that condition to a minimal deterministic reproducer, proposes a
candidate fix, and proves whether the fix works.

## The Problem

Flaky end-to-end tests pass and fail without an obvious code change. They waste time,
block deployments, and eventually teach teams to distrust their test suites.

Existing tools are good at identifying repeated failures, storing traces, and
quarantining unstable tests. The developer is still commonly left with the difficult
questions:

- Is the problem in the test, the application, the backend, authentication, or CI?
- Which timing or environmental condition triggers it?
- How can another developer reproduce it reliably?
- Did a proposed fix solve the cause, or merely hide the failure?
- Which commit introduced the behavior?

FlakeLab treats flaky-test diagnosis as an experimental search problem rather than a
log-summarization problem.

## Product Promise

Given an existing Playwright test, FlakeLab should be able to:

1. Confirm whether the test is flaky.
2. Form plausible hypotheses about the cause.
3. Run controlled experiments against those hypotheses.
4. Find the smallest environmental condition that reliably causes failure.
5. Classify likely ownership of the failure.
6. Generate a portable reproducer.
7. Propose a candidate patch in an isolated environment.
8. Verify the patch against both hostile and normal conditions.
9. Produce an inspectable report with real execution evidence.
10. Optionally locate the commit that introduced the failure.

The memorable promise is:

> Other tools tell you which test is flaky. FlakeLab discovers what makes it fail and
> gives you a deterministic reproducer.

## Primary User Experience

FlakeLab is CLI-first because tests, source code, configuration, Git history, and CI
metadata already live in the developer's repository.

```bash
npx flakelab diagnose tests/checkout.spec.ts --agent --open
```

The terminal streams the investigation:

```text
FlakeLab · checkout.spec.ts

● Preparing environment       cached snapshot
● Establishing baseline       8 trials in parallel
● Investigating hypotheses

  1. Network ordering         confirmed
  2. Shared test state        rejected
  3. Stale locator            rejected

● Minimizing trigger          3 candidates remaining
● Verifying reproduction      10/10 failed

✓ Minimal reproducer found in 38.4 seconds

  GET /api/cart delayed by 184 ms

Opening report...
```

The CLI then opens a visual HTML report. The report is the primary explanation and
demonstration surface; the CLI is the primary execution and integration surface.

Additional commands may include:

```bash
npx flakelab replay flakelab.repro.yaml
npx flakelab verify flakelab.repro.yaml --patch candidate.diff
npx flakelab bisect --repro flakelab.repro.yaml --good v1.4.0 --bad HEAD
```

## System Architecture

```text
Developer / CI
      │
      ▼
FlakeLab CLI
      │
      ▼
TypeScript Orchestrator
      ├── AI Flake Investigator
      ├── Experiment Scheduler
      ├── Fault-Injection Plugins
      ├── Statistical Evaluator
      ├── Delta-Debugging Minimizer
      └── Report Generator
                 │
                 ▼
          Solari Infrastructure
      ┌──────────┴───────────┐
      ▼                      ▼
Sandbox snapshots       Cloud browsers
and parallel forks      and Playwright
      │                      │
      └──────────┬───────────┘
                 ▼
      Traces, recordings, logs,
      screenshots, and outcomes
                 │
                 ▼
       Portable evidence bundle
```

## Technology Stack

The implementation should use TypeScript end-to-end.

- Node.js 22
- TypeScript in strict mode
- pnpm workspaces
- `@solarisdk/sandbox`
- `@solarisdk/browser`
- Playwright Test
- Zod for configuration, tool, and artifact schemas
- Vercel AI SDK Core for provider-neutral structured agent workflows
- `@ai-sdk/groq` with `qwen/qwen3.8-27b` as the initial investigator model
- Playwright Test for browser, integration, and focused unit-style tests
- `tsx` for development
- `tsup` for packaging the CLI
- React and Vite for the report interface
- Tailwind CSS for presentation
- Recharts for experiment and failure-rate visualizations
- NDJSON and JSON files for run persistence

The first version should not require a database. Each diagnosis produces a portable
artifact directory:

```text
.flakelab/runs/run_01/
├── manifest.json
├── trials.ndjson
├── hypotheses.json
├── minimal-reproducer.yaml
├── candidate.diff
├── report.html
├── screenshots/
├── traces/
└── recordings/
```

## Solari's Role

Solari is fundamental to the execution model rather than an incidental integration.

### Sandboxes

- Clone and prepare the target repository.
- Install dependencies and build the application once.
- Snapshot the prepared environment.
- Rewind the same machine between trials when appropriate.
- Create independent workers from one snapshot for parallel experiments.
- Apply candidate patches without modifying the developer's working tree.
- Expose the application and reports through public preview URLs when requested.

### Cloud Browsers

- Run Playwright tests in isolated cloud browser environments.
- Apply browser-level network, locale, storage, and viewport faults.
- Capture screenshots, console errors, and network behavior.
- Record the final failing and fixed sessions for review.

Desktop sessions are deliberately excluded from the first version.

## Fault-Injection Model

Faults should be implemented as small, composable plugins:

```ts
interface FaultPlugin<TConfig> {
  name: string
  apply(context: RunContext, config: TConfig): Promise<void>
  cleanup(context: RunContext): Promise<void>
}
```

The initial fault set should target common causes of end-to-end flakiness:

- Network latency
- Request failure and retry
- Response reordering
- Slow application startup
- Delayed hydration
- Animation slowdown
- Locale and timezone changes
- Viewport changes
- Browser storage changes
- Expired authentication
- Parallel worker pressure
- Shared server-state leakage
- Clock and random-seed changes

The fault system must use deterministic seeds and record every applied condition.

## The AI Flake Investigator

The AI component should behave like a debugging engineer conducting experiments. It
must not be a decorative chat interface or an ungrounded failure summarizer.

The investigator:

1. Reads the failing test and relevant application code.
2. Inspects passing and failing evidence.
3. Maintains a structured list of competing hypotheses.
4. Chooses the next highest-value experiment within a fixed budget.
5. Revises or rejects hypotheses after receiving real results.
6. Requests deterministic minimization when a trigger is found.
7. Produces a candidate patch inside an isolated sandbox.
8. Requests hostile, normal, and nearby regression validation.
9. Explains its conclusion using experiment IDs and observed evidence.

The agent receives a constrained tool surface:

```ts
const investigatorTools = {
  readTest,
  searchCode,
  inspectTrace,
  compareRuns,
  listAvailableFaults,
  runExperiment,
  minimizeFailure,
  createPatchSandbox,
  applyCandidatePatch,
  validateCandidatePatch,
}
```

The model should be provider-neutral through an adapter. The core diagnostic engine
must remain useful without a model configured.

### Division of Responsibility

| AI investigator | Deterministic FlakeLab engine |
| --- | --- |
| Proposes hypotheses | Decides whether a test passed |
| Selects useful experiments | Calculates failure frequency |
| Identifies suspicious code | Computes statistical confidence |
| Proposes candidate changes | Minimizes the fault combination |
| Explains the causal story | Verifies the patch under real execution |

The AI may not declare a cause solely from appearance. Every high-confidence diagnosis
must cite an intervention that materially changed the observed failure rate.

## Counterexample Minimization

Once a fault combination reproduces the failure, FlakeLab should use delta debugging
to remove unnecessary conditions.

```text
Initial failure:
  network delay + French locale + mobile viewport + four workers

Minimized failure:
  network delay + four workers
```

It should then minimize numeric parameters where possible:

```text
1000 ms → 500 ms → 250 ms → 184 ms
```

Because flaky behavior is probabilistic, a candidate should be evaluated through
multiple trials and a configured reproduction threshold rather than one pass or fail.

## Failure Classification

FlakeLab should classify likely ownership using evidence-backed categories:

```text
PRODUCT_RACE
TEST_SELECTOR
TEST_STATE_LEAK
BACKEND_NONDETERMINISM
AUTH_EXPIRATION
EXTERNAL_DEPENDENCY
INFRASTRUCTURE_PRESSURE
UNKNOWN
```

Example:

```text
Classification: PRODUCT_RACE

Evidence:
- Failure persists with one worker.
- Failure persists with semantic locators.
- Backend state differs between passing and failing runs.
- Delaying /api/cart reproduces the failure.
- Waiting for cart hydration eliminates it.
```

## Portable Reproducer

The most important output is an executable reproducer that can be committed to the
repository:

```yaml
version: 1
test: tests/checkout.spec.ts

environment:
  workers: 4

faults:
  - type: network-delay
    match: "**/api/cart"
    delayMs: 184

expectedFailure:
  type: assertion
  messageIncludes: "Checkout total"
```

Running the reproducer should reliably recreate the previously intermittent failure:

```bash
npx flakelab replay flakelab.repro.yaml
```

## Proof of Fix

A candidate patch is not considered successful merely because the test becomes green.
FlakeLab must compare before and after behavior:

```text
Minimal hostile condition
  Before patch: 20/20 failed
  After patch:   0/20 failed

Normal environment
  Before patch: 20/20 passed
  After patch:  20/20 passed

Nearby regression tests
  After patch:  14/14 passed
```

The validator should reject suspicious fixes such as:

- Removing assertions
- Skipping the test
- Catching and ignoring the error
- Increasing global timeouts without justification
- Disabling concurrency merely to hide shared-state bugs
- Changing expected behavior to match the failure

The proposed patch should be returned as a reviewable diff and never applied to the
developer's working tree by default.

## Statistical Git Bisect

After producing a reliable trigger, FlakeLab may search Git history for the introducing
commit:

```bash
npx flakelab bisect \
  --repro flakelab.repro.yaml \
  --good v1.4.0 \
  --bad HEAD
```

Each midpoint is built in an isolated Solari sandbox and evaluated through repeated
trials. The output should identify the first commit whose failure probability crosses
the configured threshold.

This is a stretch feature, but it is one of the strongest technical differentiators.

## Performance Strategy

The warm path should feel fast even when many experiments are required.

- Cache a prepared snapshot by commit, lockfile, and build configuration.
- Install and build dependencies only once per cache key.
- Run independent trials in parallel.
- Share an application sandbox for browser-only faults.
- Fork sandboxes only when server state must be isolated.
- Run broad screening without recording every trial.
- Record only representative failures and final proof runs.
- Stop experiments early when the confidence threshold has been met.
- Ask the agent to select experiment batches rather than calling the model between
  every individual trial.
- Send compact trace summaries to the model instead of complete logs and DOMs.

The target for a warm diagnosis is:

> Produce a deterministic reproducer in less than four times the duration of one test
> by using parallel execution.

For a ten-second test, the target is approximately forty seconds. Cold dependency
installation and unusually long workflows will take longer and must be reported
honestly.

## Security and Trust

FlakeLab will process source code, browser state, test credentials, network traces, and
potentially authenticated sessions. Reports must redact:

- Cookies
- Authorization headers
- API keys
- Environment variables
- Password fields
- High-entropy secrets
- Sensitive query parameters

The tool must also:

- Keep model tools narrowly scoped.
- Avoid unrestricted host shell access.
- Make remote publishing opt-in.
- Display estimated resource use before large runs.
- Kill or pause Solari resources after completion.
- Record which artifacts were sent to a model provider.
- Never apply an AI patch to the user's repository without explicit approval.

## Experiment Budgets

Developers should be able to bound time, trials, and cost:

```bash
npx flakelab diagnose tests/checkout.spec.ts \
  --max-trials 40 \
  --max-minutes 3 \
  --max-cost 2.00
```

Every report should include:

```text
Trials:          27
Parallelism:      8
Wall time:       46.2s
Browser time:     3m 18s
Agent calls:      4
Estimated cost:  $0.61
```

## Demonstration Fixture

The repository should include a small, realistic checkout application with an
intentional hydration race:

1. Product and recommendation data load quickly.
2. Cart state loads independently.
3. The Submit button becomes enabled before cart hydration completes.
4. The existing Playwright test usually passes.
5. A particular response-ordering condition makes it fail reliably.

The demonstration should show:

1. A normal run passing.
2. Repeated runs exposing intermittent failure.
3. The AI investigator proposing competing hypotheses.
4. Parallel Solari experiments rejecting incorrect hypotheses.
5. Fault minimization finding the triggering delay.
6. The generated reproducer failing consistently.
7. A candidate patch being created in an isolated sandbox.
8. Proof-of-fix validation succeeding.
9. Optional statistical Git bisect finding the introducing commit.

## Delivery Surfaces

The intended order is:

1. CLI
2. Portable local HTML report
3. Optional published Solari preview report
4. GitHub Action and job summary
5. Hosted team dashboard only after the core is proven

The GitHub integration can begin as a normal action:

```yaml
- run: npx flakelab diagnose --changed --ci
```

A pull request summary should link to the report and reproducer without requiring a
custom GitHub App in the first version.

## Development Phases

Development should proceed through explicit gates. A phase is complete only when its
exit criterion works end to end; code volume or partial components do not count as
completion.

### Phase 0: Technical Feasibility Spike

**Status: Complete — verified end to end on 2 September 2026.**

**Goal:** Prove that the critical Solari execution path works before building product
infrastructure or UI.

Build the smallest possible vertical experiment:

- Configure the Solari API key without committing it.
- Start a small HTTP application in a Solari sandbox.
- Expose it through a sandbox preview URL.
- Take a snapshot of the prepared application environment.
- Create an independent sandbox from that snapshot.
- Launch a Solari cloud browser through the TypeScript SDK.
- Run one Playwright assertion against the preview URL.
- Apply one network-delay fault with Playwright routing.
- Capture the pass or failure result.
- Close the browser and destroy the temporary machines.
- Download or retrieve one recorded browser run.

**Exit criterion:** One script demonstrates
`sandbox → snapshot → preview URL → cloud browser → injected delay → test result → Playwright trace`
without leaked resources.

Solari rrweb replay is an optional secondary artifact. The Playwright trace is the
required evidence layer because it is produced directly by the test run.

Verified result from [`projects/flakelab/src/verify-solari.ts`](projects/flakelab/src/verify-solari.ts):

- The source sandbox served a healthy public preview.
- A new sandbox restored from its snapshot and served the same application.
- A Solari browser observed the injected 750 ms API delay and completed the assertion.
- Playwright produced a 20,745-byte trace archive.
- Solari finalized and returned a 2,618-byte rrweb replay containing seven events.
- The verifier exited successfully after destroying both sandboxes and releasing the browser.

If this phase fails because a required Solari capability is unavailable, redesign the
execution model before continuing.

### Phase 1: Local Diagnostic Core

**Status: Complete — verified end to end on 2 September 2026.**

**Goal:** Build a deterministic engine that can run without AI and without distributed
orchestration.

Implement:

- pnpm workspace and TypeScript project structure
- Strict shared schemas for runs, trials, faults, and outcomes
- CLI command parsing
- Test selection
- A local trial runner
- Deterministic seed handling
- NDJSON event logging
- One `network-delay` fault plugin
- One intentionally flaky checkout fixture
- Cleanup behavior for failed and interrupted runs
- Unit tests for schemas, seeds, and plugin lifecycle

**Exit criterion:** The fixture normally passes, fails reliably when the known fault is
enabled, and produces a complete machine-readable trial artifact.

Verified result from [`projects/flakelab/src/cli.ts`](projects/flakelab/src/cli.ts):

- A four-trial diagnosis used deterministic seeds and alternated clean and delayed runs.
- Both baseline checkout trials passed and both 250 ms network-delay trials failed.
- The summary reported a baseline failure rate of 0 and a fault failure rate of 1.
- The run produced ten schema-validated NDJSON lifecycle events with hashed failure
  signatures and no captured source or raw browser logs.
- Focused tests cover schema bounds, repeatable trial planning, interruption behavior,
  fault cleanup, the normal checkout path, and deterministic timeout reproduction.

### Phase 2: Solari Parallel Runner

**Status: Complete — verified end to end on 2 September 2026.**

**Goal:** Move the deterministic runner onto fast, isolated Solari infrastructure.

Implement:

- Repository preparation inside a sandbox
- Dependency and build caching
- Snapshot cache keys based on commit, lockfile, and configuration
- Sandbox rewind and fork strategies
- Solari-backed Playwright fixtures
- Parallel trial scheduling
- Browser and sandbox lifecycle tracking
- Concurrency limits and backpressure
- Retry policy for transient infrastructure errors
- Guaranteed cleanup on success, failure, timeout, or interruption
- Wall-time and resource-usage accounting

**Exit criterion:** At least eight independent trials run concurrently from one prepared
environment, return structured results, and leave no running resources after completion.

The parallel run should be materially faster than executing the same eight trials
sequentially.

Verified result from
[`projects/flakelab/src/verify-solari-parallel.ts`](projects/flakelab/src/verify-solari-parallel.ts):

- Eight independent Solari browser trials ran concurrently against one application sandbox
  restored from a prepared snapshot.
- All four baseline trials passed and all four 250 ms network-delay trials failed, with no
  infrastructure errors.
- Peak concurrency reached eight. A representative parallel run completed in 43.3 seconds;
  the same eight trials completed sequentially in 176.1 seconds, a 4.07× wall-time speedup.
- The parallel run accumulated 100.2 seconds of trial runtime while remaining within the
  wall-time target through overlap.
- Resource accounting confirmed that all eight browser sessions and both sandboxes were
  released. Cleanup failures are surfaced as errors instead of being silently ignored.
- The snapshot cache is keyed by Git commit, pnpm lockfile, and prepared fixture content. A
  warm verification reused the same snapshot and skipped the preparation sandbox.
- Transient transport, capacity, timeout, connection, and retryable gateway failures use
  bounded retries; concurrency-limit and configuration failures are not retried.
- Signed preview and browser endpoints are never written to logs or artifacts.

### Phase 3: Flake Confirmation and Reproducer

**Status: Complete — verified end to end on 2 September 2026.**

**Goal:** Deliver the first useful version of FlakeLab.

Implement:

- Baseline repeated-run analysis
- Failure-signature normalization
- Reproduction-rate calculation
- Confidence thresholds
- A small initial matrix of fault plugins
- Combination-level delta debugging
- Numeric threshold minimization
- Portable `flakelab.repro.yaml` generation
- `flakelab replay` command
- Reproduction verification across multiple trials

**Exit criterion:** Starting from the intermittently failing fixture test, FlakeLab
discovers the triggering network condition, reduces it to a minimal value, writes a
reproducer, and makes the failure occur consistently through `flakelab replay`.

**Milestone:** This is the technical MVP. It solves a real problem even without an AI
model or polished dashboard.

Verified result from
[`projects/flakelab/src/commands/discover.ts`](projects/flakelab/src/commands/discover.ts)
and [`projects/flakelab/src/commands/replay.ts`](projects/flakelab/src/commands/replay.ts):

- Four clean baseline trials passed before minimization began.
- Eight bounded candidate experiments reduced the known network trigger from 125 ms to a
  75 ms minimum on the verification host.
- The minimum candidate failed in four of four trials. Its observed failure rate was 1.0 and
  its 80% Wilson lower confidence bound was 0.7089, exceeding the configured 0.7 threshold.
- Confirmed candidates at 125, 93, 77, and 75 ms produced the same normalized failure
  signature, `c962cb174272920b`.
- The generated `flakelab.repro.yaml` replayed in four parallel trials with four failures,
  no infrastructure errors, and a matching failure signature.
- The initial deterministic browser-fault matrix contains network-delay and HTTP-failure
  injection, with lifecycle tests proving that routes are removed after use.
- Combination-level delta debugging is generic and tested independently; integer binary
  minimization finds the smallest statistically confirmed delay.

The exact delay threshold is environment-dependent. The portable artifact records the
measured trigger, seed, trial count, endpoint pattern, expected failure rate, and normalized
signature so another run can verify the result rather than assuming it.

### Phase 4: AI Flake Investigator

**Status: Complete — verified end to end on 2 September 2026.**

**Goal:** Add evidence-grounded agentic investigation without weakening deterministic
correctness.

Implement:

- Provider-neutral model adapter
- Structured hypothesis ledger
- Investigator system instructions
- Constrained read-only repository and trace tools
- Experiment-selection tools
- Experiment budgets for trials, time, and cost
- Batched experiment planning
- Hypothesis confirmation and rejection rules
- Evidence citations using run and experiment IDs
- Graceful operation when no model is configured

The first agent version should diagnose only. It should not edit code yet.

**Exit criterion:** The agent begins with at least two plausible hypotheses, chooses
experiments that distinguish them, rejects unsupported explanations, and reaches the
known fixture cause using only real evidence returned by FlakeLab tools.

Verified result from
[`projects/flakelab/src/investigator/agent.ts`](projects/flakelab/src/investigator/agent.ts):

- Vercel AI SDK provides the provider-neutral structured workflow and Groq routing;
  `qwen/qwen3.8-27b` is the initial configured model.
- The agent proposed a network-deadline hypothesis and an intermittent HTTP-failure
  hypothesis after inspecting a bounded local source graph.
- It selected one clean baseline, one 125 ms network-delay intervention, and one injected 503
  response as a single experiment batch. FlakeLab executed all twelve trials concurrently.
- Baseline trials passed 4/4. Network-delay trials failed 4/4 with the known normalized
  signature and an 80% Wilson lower bound of 0.7089. HTTP-failure trials did not cross the
  confirmation threshold.
- The agent rejected the HTTP-failure explanation and correctly identified the application's
  100 ms in-page deadline expiring before the delayed checkout response.
- Deterministic ledger rules—not model prose—required two competing hypotheses, an unsupported
  alternative, one confirmed intervention, and valid experiment citations before accepting the
  report.
- The successful live investigation completed in approximately 34 seconds using two model
  calls, 3,469 input tokens, 569 output tokens, and an estimated model cost of $0.0051.
- Experiment, trial, wall-time, model-step, output-token, and estimated-cost budgets are bounded.
  Interruptions propagate to active model requests and Playwright subprocesses.
- Source access is confined to the selected test and at most eight local imports, with a 64 KiB
  aggregate limit, dependency/path traversal rejection, and credential-like assignment blocking.
- Without `GROQ_API_KEY`, FlakeLab fails the AI command with actionable guidance while the full
  deterministic engine remains available.

### Phase 5: Patch Sandbox and Proof of Fix

**Status: Complete — verified end to end on 3 September 2026.**

**Goal:** Close the loop from diagnosis to a verified candidate repair.

Implement:

- Isolated patch sandbox creation
- Narrow file-edit capability for the investigator
- Reviewable Git diff generation
- Detection of suspicious test weakening edits
- Hostile reproducer validation before and after the patch
- Clean-environment control trials
- Nearby regression-test execution
- Before-and-after failure-rate comparison
- Explicit human approval before any local application of a patch

**Exit criterion:** The investigator proposes a valid repair for the fixture race, the
minimal reproducer changes from reliably failing to reliably passing, normal behavior
continues to pass, and the developer's working tree remains untouched.

Verified result from
[`projects/flakelab/src/commands/repair.ts`](projects/flakelab/src/commands/repair.ts):

- Groq generated an exact, reviewable application-source edit using the bounded source context
  from Phase 4. Invalid structured output receives one bounded schema-repair retry; unsafe edits
  receive one separately bounded policy-revision attempt.
- Static policy rejects edits outside approved JavaScript/TypeScript source, selected-test
  changes, test skipping or assertion weakening, lint/type suppressions, credential-like
  assignments, path escapes, ambiguous replacements, and numeric-only timeout increases.
- The unmodified checkout failed all four local hostile trials at 125 ms delay with the expected
  `c962cb174272920b` signature and a bounded reason showing the product's timeout state.
- Candidate source was uploaded without credentials to a disposable, kill-on-timeout Solari
  microVM. Model-written code was never executed on the developer host.
- Remote typecheck and type-aware ESLint passed. The candidate then passed four of four hostile
  trials, four of four clean control trials, and two of two nearby regression trials.
- `flakelab.proof.json` records `execution: solari-microvm`, static gates, failure rates,
  confidence bounds, bounded diagnostics, and regression results. `candidate.diff` is written for
  human review and is not applied to the working tree.
- Node 22.14.0 and pnpm 11.6.0 are pinned in the disposable environment. Long Chromium setup runs
  detached with bounded status polling and reconnects after transient Solari control-channel
  drops; sandbox cleanup remains guaranteed.

The live run intentionally proves the cold path. Caching a prepared dependency-and-browser
snapshot is the first Phase 6 performance optimization so subsequent patch proofs avoid setup
latency.

### Phase 6: Report, Security, and Developer Experience

**Status: Complete — verified end to end on 3 September 2026.**

**Goal:** Turn the working engine into a trustworthy and impressive developer product.

Implement:

- Live, concise terminal progress
- Portable React/Vite HTML report
- Experiment timeline and hypothesis history
- Pass/fail and failure-rate matrix
- Minimal-trigger visualization
- Embedded screenshots and links to recordings and traces
- Failure ownership classification
- Secret and credential redaction
- `--open` local report behavior
- Optional `--publish` behavior with explicit confirmation
- Human-readable errors and recovery guidance
- Installation and quickstart documentation

**Exit criterion:** A developer unfamiliar with the codebase can clone the repository,
follow the quickstart, run one command, understand the diagnosis, replay the failure,
and review proof of the fix without assistance.

**Milestone:** This is the challenge-ready version. Work after this point must not
destabilize the core demonstration.

Verified result from
[`projects/flakelab/src/commands/report.ts`](projects/flakelab/src/commands/report.ts):

- A new `flakelab report` command loads and validates the investigation, reproducer, patch proof,
  and artifact paths, then emits concise progress separately from machine-readable command output.
- The deterministic classifier maps the confirmed timing intervention to `PRODUCT_RACE` with high
  confidence and explains why ownership belongs at the application boundary.
- Vite bundles a React/Recharts interface into one 636 KiB HTML file with no runtime dependencies.
  The report includes a causal summary, minimal-trigger visualization, experiment timeline,
  hypothesis ledger, failure-rate chart, proof matrix, static gates, model cost, and artifact links.
- Evidence strings pass through bounded credential redaction. Embedded JSON and document titles
  are HTML-safe, artifact links are project-confined, and a restrictive content security policy
  disables runtime network access.
- `--open` launches the local artifact without shell interpolation. `--publish` requires an
  interactive confirmation at action time, uploads only the already-redacted report, and uses a
  one-hour kill-on-timeout Solari sandbox.
- Desktop and 390 px mobile browser reviews confirmed readable hierarchy, responsive layout, and
  visible causal/proof information. Focused Playwright coverage loads the report from a local file,
  verifies the chart and core evidence, and confirms that no external script is required.
- The generated fixture report identifies the 125 ms checkout delay, contrasts the confirmed and
  rejected hypotheses, and shows the successful 4/4 hostile, 4/4 control, and 2/2 regression proof
  from Phase 5.

### Phase 7: Statistical Git Bisect

**Status: Complete — verified end to end on 3 September 2026.** The local engine, CLI,
synthetic Git-history acceptance tests, strict typecheck, and lint checks passed. The live
acceptance verifier then used disposable Solari snapshots and trials to identify the exact
intentional regression in its four-commit history.

**Goal:** Add the strongest technical stretch feature.

Implement:

- Good and bad revision selection
- Parallel preparation of midpoint commits
- Repeated probabilistic evaluation per revision
- Confidence-aware good/bad classification
- Incompatible historical-build handling
- Snapshot reuse across repeated revision tests
- First-failing-commit report

**Exit criterion:** Given the demonstration repository's known-good and known-bad
revisions, FlakeLab identifies the intentionally introduced regression commit and shows
the evidence used at each bisection decision.

Implemented behavior:

- Resolve and validate the full ancestry path between measured good and bad endpoints.
- Prepare two statistically useful midpoint revisions concurrently.
- Archive commits without remotes or credentials and execute all historical code only in Solari.
- Build one shared toolchain/browser snapshot, fork revision preparations from it, then fork every
  repeated trial from a revision-specific snapshot.
- Increase trial batches until the 80% Wilson interval proves good or bad, or the bounded trial
  budget is exhausted.
- Keep infrastructure errors visible but calculate confidence from valid test observations, with
  hard caps on total trials, infrastructure errors, remote command time, and admission retries.
- Preserve dependency, package, and test-discovery failures as incompatible evidence.
- Reject non-monotonic results instead of returning a misleading regression commit.
- Emit an exact `firstFailingCommit` only when no incompatible or inconclusive revision obscures
  the boundary; otherwise emit the earliest proven bad commit with a non-exact result.
- Verify the search algorithm against a real temporary four-commit Git history in the default,
  credit-free Playwright suite.
- The live `pnpm verify:bisect` run identified regression `c8beffa7d29f`: the regression and known
  bad endpoint each failed 4/4 valid trials with an 80% Wilson lower bound of 0.709, while the
  immediately preceding revision passed 4/4 with an upper bound of 0.291. It wrote the validated
  decision record to `.flakelab/bisect-demo.json` and released all owned sandboxes and snapshots.

**Milestone:** This is the standout version.

### Phase 8: CI Integration and Public Demonstration

**Status: Implementation complete; hosted GitHub acceptance pending commit and environment
configuration.** The action/workflow schemas, changed-test selection, job-summary escaping, and
artifact behavior are covered by the local Playwright suite. An actual pull-request run requires
these currently untracked project files to be committed and pushed, plus protected GitHub
environment secrets; FlakeLab does not create or push a repository/PR without explicit authority.

**Goal:** Package the project so it looks and behaves like a tool developers could adopt.

Implement:

- GitHub Action wrapper
- Markdown job summary
- Changed-test selection
- CI artifact upload
- Optional published report URL
- Example pull request containing a newly introduced flake
- Short demonstration video or animated walkthrough
- Architecture diagram
- Public repository documentation
- Cost, limitations, and threat-model notes

**Exit criterion:** A sample pull request triggers FlakeLab, reports the new flake,
attaches a deterministic reproducer, and links to an evidence-rich report. A reviewer
can understand the entire value proposition in under two minutes.

Implemented behavior:

- A reusable composite action installs pinned pnpm 11.6, Node.js 22.14, locked dependencies, and
  Chromium before running the full discovery → investigation → repair → report chain.
- Git-aware selection prefers directly changed tests and falls back to a bounded browser/fixture
  suite for application or test-infrastructure changes.
- The Markdown job summary escapes model-controlled text and shows the minimal trigger, causal
  conclusion, hostile/control proof matrix, static checks, model usage, and artifact URL.
- The seven-day artifact bundles the offline report, investigation, reproducer, discovery data,
  proof, diff, and changed-test manifest. Rejected repairs upload evidence before failing the job.
- The pull-request workflow grants only `contents: read`, does not persist checkout credentials,
  excludes fork PRs from secret-backed execution, avoids `pull_request_target`, and requires a
  protected `flakelab` environment.
- A sample regression patch and complete PR narrative exercise the checkout race and expected CI
  story without modifying the working tree.
- The public landing README links to a verified 90-second demo script, animated SVG walkthrough,
  Mermaid architecture, cost/limitations notes, and explicit threat model.

### Phase Boundaries

| Boundary | Included phases | Meaning |
| --- | --- | --- |
| Feasibility proven | Phase 0 | Solari supports the critical execution chain |
| Local engine working | Phases 0–1 | Deterministic fault injection works |
| Technical MVP | Phases 0–3 | FlakeLab finds and reproduces a real flake |
| Agentic product | Phases 0–5 | AI diagnoses and validates a candidate fix |
| Challenge ready | Phases 0–6 | Complete, secure, understandable demonstration |
| Standout version | Phases 0–7 | Statistical Git bisect is working |
| Adoption ready | Phases 0–8 | CI and public presentation are complete |

### Execution Rule

Phases 0–3 are non-negotiable. Phase 4 begins only after deterministic diagnosis works.
Phase 5 begins only after the agent can reach a grounded diagnosis. Phase 7 and Phase 8
must never delay or destabilize the challenge-ready Phase 6 demonstration.

## Scope

### Must Ship

- TypeScript CLI
- Solari sandbox preparation and snapshot caching
- Parallel Solari browser trials
- Initial fault-injection plugin set
- Deterministic outcome collection
- Statistical failure confirmation
- AI investigator with a constrained tool loop
- Counterexample minimization
- Portable YAML reproducer
- Proof-of-fix validation
- Secret redaction
- Polished HTML report
- Real end-to-end demonstration fixture

### Strong Stretch Goals

- Statistical Git bisect
- GitHub Action integration
- Optional published preview report
- Candidate patch generation and validation

### Explicitly Excluded from Version One

- Cypress and Selenium support
- Desktop testing
- Multi-user accounts
- Hosted database infrastructure
- A fault-plugin marketplace
- Generic autonomous test generation
- Automatic pull-request creation
- Silent self-healing of tests
- Universal support for every repository and deployment architecture

## Success Criteria

The project is successful when a reviewer can clone the repository, configure the
required credentials, and run one command that:

1. Reproduces a genuinely intermittent Playwright failure.
2. Uses parallel Solari execution to investigate it.
3. Shows an AI agent forming and testing hypotheses.
4. Produces a minimal fault condition backed by repeated evidence.
5. Generates a portable reproducer that fails consistently.
6. Produces a candidate fix without modifying the user's working tree.
7. Demonstrates that the fix passes both the hostile reproducer and normal tests.
8. Opens a polished report containing traces, recordings, statistics, and reasoning.

## What We Finally Want to Achieve

At the end of this project, a developer should be able to point FlakeLab at a flaky
Playwright test and receive, within roughly a minute on the warm path, an evidence-backed
answer to four questions:

1. **What exact condition causes this test to fail?**
2. **Is the fault in the test, the product, the backend, authentication, or the
   environment?**
3. **How can anyone reproduce it deterministically?**
4. **Does the proposed fix remove the cause without weakening the test or introducing
   a regression?**

The final demonstration should begin with a test that appears healthy, expose its
intermittent failure, let the AI investigator discover the triggering condition through
real experiments, reduce that condition to a deterministic reproducer, propose a patch,
and prove the patch across hostile and normal runs.

The finished artifact is not merely a dashboard, test runner, or AI explanation. It is
a working causal debugging system in which AI supplies investigative judgment, Solari
supplies fast isolated execution, and deterministic experiments supply the proof.

> **FlakeLab should turn “it only fails sometimes” into “here is the exact trigger,
> here is the reproducer, and here is proof that the fix works.”**

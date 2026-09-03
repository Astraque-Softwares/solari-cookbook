# FlakeLab

FlakeLab is an AI debugging scientist for flaky Playwright tests. The product architecture,
scope, and milestone-based development plan live in
[`../../FLAKELAB.md`](../../FLAKELAB.md).

The local diagnostic core can already run controlled baseline and fault-injected trials:

```bash
pnpm flakelab diagnose tests/fixtures/flaky-checkout.spec.ts \
  --runs 4 \
  --seed 42 \
  --delay-ms 250
```

The command runs alternating control and network-delay trials, prints their failure rates,
and writes a validated NDJSON event stream under `.flakelab/runs/`. The included checkout
fixture passes normally and fails reliably when its checkout request is delayed.

## Discover and replay a minimal reproducer

Run repeated baseline and fault trials, then minimize the delay that crosses the configured
failure-rate and confidence thresholds:

```bash
pnpm flakelab discover tests/fixtures/flaky-checkout.spec.ts \
  --trials 4 \
  --concurrency 4 \
  --seed 42 \
  --max-delay 125 \
  --min-rate 0.7 \
  --output flakelab.repro.yaml
```

The command writes a strict portable YAML reproducer and a JSON discovery sidecar containing
the evidence for every candidate. It normalizes Playwright failures into stable signatures,
uses an 80% Wilson lower confidence bound, and accepts a trigger only when both the observed
rate and lower bound meet the requested minimum. Replay the result with:

```bash
pnpm flakelab replay flakelab.repro.yaml --concurrency 4
```

The current browser-fault matrix supports deterministic network delay and injected HTTP
failures. Fault routes are removed after every trial, including failed tests.

## AI investigator

Set `GROQ_API_KEY` in the shell or local `.env`, then run:

```bash
pnpm flakelab investigate tests/fixtures/flaky-checkout.spec.ts \
  --trials 4 \
  --concurrency 4 \
  --max-delay 125
```

The investigator uses the provider-neutral [Vercel AI SDK](https://ai-sdk.dev/docs/agents/overview)
with Groq's [`qwen/qwen3.8-27b`](https://console.groq.com/docs/model/qwen/qwen3.8-27b)
model. It makes two bounded model calls: one to propose competing hypotheses and a three-part
experiment batch, and one to assess the resulting evidence. FlakeLab—not the model—executes
trials, calculates confidence, enforces budgets, and decides whether a causal claim is valid.

The model receives only the selected test and at most eight local imported source files through
a 64 KiB, path-confined, credential-blocking reader. The resulting evidence-backed report is
written to `flakelab.investigation.json`. If no model key is configured, deterministic
`diagnose`, `discover`, and `replay` commands continue to work.

## Isolated candidate repair

After reviewing an investigation, generate and prove a candidate without changing the working
tree:

```bash
pnpm flakelab repair flakelab.investigation.json \
  --reproducer flakelab.repro.yaml \
  --patch candidate.diff \
  --proof flakelab.proof.json
```

This command requires both `GROQ_API_KEY` and `SOLARI_API_KEY`. The model can propose only exact,
bounded edits to application source it previously received. FlakeLab rejects test changes,
assertion weakening, lint suppressions, credential-like additions, path escapes, and numeric-only
timeout increases before execution.

The candidate is copied into a disposable Solari microVM. Typecheck, lint, hostile trials, clean
controls, and nearby regression tests all run there. The machine is destroyed afterward, and the
candidate is returned as a reviewable diff; FlakeLab never applies it to the local checkout.
Cold validation installs the pinned Node/pnpm toolchain and Chromium, so it is intentionally
slower than the future snapshot-backed warm path.

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
The evidence is schema-validated and credential-redacted before rendering. A restrictive content
security policy blocks runtime network access, so the report remains usable offline.

`--open` launches only the local file. `--publish` is optional and always asks for interactive
confirmation immediately before creating a public Solari preview. Published reports expire and
their hosting sandbox is automatically killed after at most 60 minutes.

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
investigation, reproducer, discovery evidence, proof, candidate diff, and selection manifest. A
rejected repair still uploads its evidence before the job reports failure.

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

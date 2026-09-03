# FlakeLab

> Turn “it only fails sometimes” into an exact trigger, a portable reproducer, and proof
> that the fix works.

FlakeLab is an AI debugging scientist for flaky Playwright tests. It does not stop at rerunning
a test or summarizing a trace. It forms competing hypotheses, changes one condition at a time,
measures the resulting failure probability, minimizes the trigger, proposes a bounded patch, and
proves that patch in disposable Solari microVMs.

![Animated FlakeLab walkthrough](docs/assets/flakelab-walkthrough.svg)

## The two-minute version

```bash
cd projects/flakelab
pnpm install --frozen-lockfile

pnpm flakelab investigate tests/fixtures/flaky-checkout.spec.ts \
  --trials 4 --concurrency 4 --max-delay 125

pnpm flakelab repair flakelab.investigation.json \
  --reproducer flakelab.repro.yaml

pnpm flakelab report flakelab.investigation.json \
  --reproducer flakelab.repro.yaml \
  --proof flakelab.proof.json \
  --patch candidate.diff \
  --open
```

The output is evidence rather than an AI guess:

- the exact fault condition and smallest confirmed parameter;
- repeated pass/fail counts with confidence bounds;
- rejected hypotheses as well as the confirmed one;
- an executable YAML reproducer;
- a reviewable candidate diff that never touches the working tree;
- hostile, normal, regression, typecheck, and lint proof;
- one offline HTML report with no runtime network dependency.

## What makes it different

| Typical flaky-test tooling | FlakeLab |
| --- | --- |
| Detects repeated failure | Intervenes on suspected causes |
| Stores traces | Connects each claim to experiment evidence |
| Quarantines unstable tests | Produces a deterministic reproducer |
| Reports a green rerun | Proves hostile and normal behavior |
| Treats Git bisect as pass/fail | Bisects failure probability with confidence bounds |

The model supplies investigative judgment through Vercel AI SDK and Groq. The deterministic
engine—not the model—decides test outcomes, confidence, minimization, policy compliance, and proof.

## CI and adoption

The reusable action at [`.github/actions/flakelab/action.yml`](.github/actions/flakelab/action.yml)
selects changed or affected browser tests, runs a bounded diagnosis, uploads the portable evidence
bundle, and writes a Markdown job summary. The example workflow runs local quality checks for every
pull request and allows secret-backed diagnosis only for same-repository or manually dispatched
runs protected by the `flakelab` GitHub environment.

## Explore

- [Detailed package guide](projects/flakelab/README.md)
- [90-second demonstration](docs/DEMO.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Costs and limitations](docs/COSTS-AND-LIMITATIONS.md)
- [Threat model](docs/THREAT-MODEL.md)
- [Sample regression pull request](examples/pull-request/README.md)
- [Full product and phase specification](FLAKELAB.md)

## Current verification

The default suite is local and credit-free. Live checks are explicit because they consume remote
resources:

```bash
cd projects/flakelab
pnpm quality
pnpm verify:solari
pnpm verify:solari-parallel
pnpm verify:bisect
```

FlakeLab is intentionally CLI-first: source, tests, Git history, and CI already live in the
repository. The single-file visual report is the explanation surface.

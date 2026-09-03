# Costs and limitations

FlakeLab bounds work explicitly rather than promising that distributed diagnosis is free.

## Cost controls

- `--max-cost` caps estimated investigator-model spend; the default is USD 0.25.
- `--max-steps`, `--max-experiments`, and `--max-trials` cap agent and experiment work.
- `--concurrency` bounds simultaneous trials; statistical bisect divides that budget across
  concurrently prepared revisions.
- Broad screening avoids recording every run. Final proof retains only evidence needed for review.
- Live Solari verification is excluded from `pnpm test` and must be requested explicitly.
- Published reports automatically expire after at most 60 minutes.

Actual model and infrastructure prices change. Consult the provider dashboards before a large run;
the report records token usage, estimated model cost, trials, concurrency, and runtime so teams can
measure their own workload instead of relying on a static estimate.

## Performance expectations

The warm target is a deterministic reproducer in less than four times one test duration through
parallel execution. Cold Node, dependency, system-library, or browser installation can take several
minutes. Snapshot reuse removes most of that cost from repeated trials and revision evaluation, but
it cannot make a never-built historical commit warm.

## Version-one limitations

- Playwright only; Cypress and Selenium are not supported.
- Network delay and request failure are the implemented fault primitives.
- The CI action deeply diagnoses one selected changed/affected browser test per run to keep cost
  bounded. The selection artifact lists the full bounded set for future matrix expansion.
- Historical revisions must contain a compatible pnpm project and discoverable Playwright test.
- Statistical bisect assumes a mostly monotonic regression history and rejects contradictory
  evidence.
- AI repair is limited to narrow application-source edits; it does not open pull requests or modify
  the local checkout.
- There is no hosted database, team dashboard, generic test generator, or silent self-healing.
- A published preview is optional and requires an explicit interactive confirmation; CI defaults to
  a private GitHub artifact.

## Honest failure modes

Solari admission, control-channel, package-registry, and browser-download failures are infrastructure
errors, not test failures. Historical setup failures are reported as incompatible. Ambiguous
failure probabilities consume another bounded batch and remain inconclusive if the budget ends.

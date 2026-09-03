# Sample pull request: introduce a checkout hydration race

This sample describes the pull request used for a public FlakeLab demonstration. Start from the
proved candidate state where checkout completion follows the API response, then apply
[`introduce-checkout-race.diff`](introduce-checkout-race.diff).

## Pull-request title

`Enable checkout deadline handling`

## Pull-request description

> Adds a 100 ms checkout deadline so the interface can surface stalled requests. The normal test
> passes, but response latency can now win the race and leave the final status at “Checkout timed
> out.” FlakeLab should discover the smallest reproducing delay, classify the product race, produce
> a deterministic reproducer, and prove the candidate repair.

The patch also touches the behavior test so changed-test selection deterministically chooses the
checkout fixture for the bounded CI diagnosis. The pull request is illustrative and is not applied
to the current working tree.

## Expected CI story

1. The local quality job runs without provider secrets.
2. A protected-environment reviewer approves the internal PR diagnosis.
3. FlakeLab selects `tests/fixtures/flaky-checkout.spec.ts`.
4. The clean baseline passes and a 125 ms checkout delay fails 4/4 times.
5. The AI investigator's product-race hypothesis is confirmed by intervention evidence.
6. The candidate passes hostile, normal, regression, typecheck, and lint proof in Solari.
7. GitHub attaches the HTML report, reproducer, investigation, proof, and diff and links them from
   the job summary.

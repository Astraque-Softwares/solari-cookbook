# 90-second FlakeLab demonstration

The fast walkthrough uses the included checkout hydration race. A warm run is the presentation
path; dependency installation and first-time browser provisioning should happen before recording.

## 0–15 seconds: show the pain

Run the checkout test normally, then explain that a slightly slower checkout response crosses a
hidden 100 ms product deadline. The test itself has not changed.

```bash
cd projects/flakelab
pnpm exec playwright test tests/fixtures/flaky-checkout.spec.ts
```

## 15–35 seconds: discover the trigger

```bash
pnpm flakelab discover tests/fixtures/flaky-checkout.spec.ts \
  --trials 4 --concurrency 4 --max-delay 125 --min-rate 0.7
```

Point out the baseline, the smallest confirmed delay, and the generated `flakelab.repro.yaml`.

## 35–55 seconds: let the investigator reason

```bash
pnpm flakelab investigate tests/fixtures/flaky-checkout.spec.ts \
  --trials 4 --concurrency 4 --max-delay 125
```

The model proposes competing explanations. FlakeLab runs the experiments and accepts only the
conclusion supported by a causal intervention.

## 55–75 seconds: prove a candidate

```bash
pnpm flakelab repair flakelab.investigation.json \
  --reproducer flakelab.repro.yaml
```

Show that `candidate.diff` is reviewable and that the working tree was not modified. The important
numbers are 4/4 hostile failures before, 4/4 hostile passes after, 4/4 control passes, and 2/2 nearby
regression passes.

## 75–90 seconds: open the evidence

```bash
pnpm flakelab report flakelab.investigation.json \
  --reproducer flakelab.repro.yaml \
  --proof flakelab.proof.json \
  --patch candidate.diff \
  --open
```

End on the causal timeline and proof matrix. The report is one offline HTML file, so it can be
opened from a CI artifact without a FlakeLab account.

## Optional standout ending

```bash
pnpm verify:bisect
```

This builds a temporary four-commit history and asks the statistical bisector to identify the
intentional regression. Keep this outside the 90-second recording unless its prepared snapshots
are already warm.

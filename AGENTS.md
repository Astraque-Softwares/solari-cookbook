# FlakeLab Repository Instructions

These instructions apply to the entire repository. Keep implementation work focused on
`projects/flakelab` unless a task explicitly changes the cookbook examples or root docs.

## Product principles

- Keep FlakeLab fast, simple, secure, and useful to working developers.
- Prefer the smallest design that solves the current problem. Do not add abstractions,
  services, dependencies, or configuration for hypothetical needs.
- Keep modules cohesive and public APIs narrow. Use guard clauses and named helpers instead
  of deeply nested control flow.
- Preserve deterministic behavior: explicit seeds, bounded retries, stable artifacts, and
  guaranteed cleanup of browsers and sandboxes.
- Use the current official Solari documentation at <https://docs.getsolari.com/> as the
  source of truth for Solari APIs. Do not rely on remembered or copied SDK behavior.

## Required tooling

- Use pnpm for package management. Do not create npm or Yarn lockfiles.
- ESLint is mandatory and must use the repository flat config in `eslint.config.mjs`.
- Type-aware linting is mandatory for TypeScript and TSX.
- Run `pnpm typecheck` after every code or configuration change.
- Run `pnpm lint` before handing work back.
- Run the smallest relevant test set while developing and `pnpm test` before handing back a
  completed behavior change.
- Use `sonar-scanner` when SonarQube credentials/configuration are available. Fix new issues
  in touched code, prioritizing bugs, vulnerabilities, security hotspots, and maintainability
  findings. Do not suppress a finding merely to make the report green; document a justified
  false positive beside the narrowest possible suppression.

## TypeScript and ESLint rules

- Do not write explicit `any` or `unknown` types. Model concrete domain types, use generics,
  or validate untrusted input into a specific type.
- Do not leave promises floating. Await them, return them, or deliberately handle them.
- Tests may disable `@typescript-eslint/no-floating-promises` when Playwright's API requires
  it; do not weaken the rest of the typed rules.
- JavaScript utility scripts under `scripts/**/*.mjs` use non-type-checked linting.
- Treat deprecated API usage as an error.
- Keep cyclomatic complexity at 10 or lower per function. Refactor with guard clauses,
  extraction, or lookup tables; do not hide branches in dense expressions.
- No human-authored source, test, or configuration file may exceed 500 lines.
  Split the file by responsibility before it reaches the limit. Generated files, lockfiles,
  vendored code, and build artifacts are exempt.
- Do not use blanket ESLint disables. Any suppression must be local, minimal, and explain why
  the rule is inapplicable.

## Testing

- Use `@playwright/test` for browser behavior and end-to-end flows.
- Test observable behavior, failure modes, security boundaries, deterministic reproduction,
  and resource cleanup. Do not test trivial constants, framework behavior, type-only code, or
  implementation details solely to increase coverage.
- Every bug fix needs a focused regression test when the behavior can be reproduced locally.
- Keep tests independent. Do not depend on execution order, shared mutable state, arbitrary
  sleeps, or live third-party services unless the test is explicitly marked as an integration
  test.
- Prefer locators by role, label, or test id. Use web-first assertions instead of fixed waits.
- Keep live Solari verification separate from the default local test suite so routine tests
  stay fast and do not consume credits.

## Security and reliability

- Never commit, print, snapshot, or attach secrets. Keep `.env` and generated artifacts
  ignored. Provide only redacted examples in tracked files.
- Validate external input at system boundaries and pass typed values into the core.
- Never concatenate untrusted input into shell commands, URLs, file paths, selectors, or SQL.
- Use least-privilege access, bounded concurrency, timeouts, and retry only transient,
  idempotent operations.
- Close browsers and destroy temporary sandboxes in `finally` blocks. A failed run must not
  leak billable resources.
- Avoid logging source contents, browser storage, credentials, or full replay data. Prefer
  structured metadata and redacted diagnostics.

## Change workflow

1. Read the relevant code, tests, and official documentation before editing.
2. Make one small, coherent change.
3. Run `pnpm typecheck` immediately.
4. Run `pnpm lint` and the smallest relevant Playwright test set.
5. Review the diff for secrets, generated files, accidental scope expansion, and files near
   the 500-line limit.
6. Report what changed, what was verified, and any remaining risk or external blocker.

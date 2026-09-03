# Threat model

FlakeLab executes repository code, handles test credentials, sends bounded context to a model, and
may publish evidence. Those capabilities make explicit trust boundaries mandatory.

## Assets

- source code and proprietary test logic;
- API keys, cookies, authorization headers, and browser storage;
- GitHub Actions tokens and environment secrets;
- traces, recordings, screenshots, diffs, and generated reports;
- paid Solari and model quotas.

## Threats and controls

| Threat | Control |
| --- | --- |
| Historical or AI-generated code affects the host | Execute it only in disposable Solari microVMs |
| Model weakens a test to make it green | Forbid test/config edits, assertion removal, blanket suppressions, and numeric-only timeout increases |
| Secret appears in model context or report | Path-confined source reader, credential-pattern blocking, schema bounds, and report redaction |
| Git reference or test path becomes shell injection | Use argument arrays without a host shell and validate bounded single-line revisions/paths |
| Failed run leaks paid resources | Kill browsers/sandboxes in `finally`; delete owned snapshots after bisect |
| Public report leaks evidence | Local offline report by default; publishing requires confirmation and expires automatically |
| Untrusted fork obtains CI secrets | Never use `pull_request_target`; skip secret-backed diagnosis for fork PRs |
| Same-repository PR changes workflow to exfiltrate secrets | Require the protected `flakelab` environment and human approval before secret-backed diagnosis |
| Third-party action supply-chain drift | Use exact released action versions and keep dependency updates reviewable |
| Unbounded cost denial of service | Trial, time, model-step, concurrency, and cost budgets |

## GitHub Actions trust boundary

The quality job runs without provider secrets and receives only `contents: read`. The diagnosis job
runs only for manual dispatch or same-repository pull requests, after the quality job, under a
protected environment. Checkout credentials are not persisted. Repository maintainers should
configure required reviewers for the `flakelab` environment and should inspect workflow changes
before approval.

Do not switch the workflow to `pull_request_target`: that would combine base-repository secrets with
attacker-controlled pull-request content. Public fork contributions should receive the local quality
gate only.

## Residual risk

A maintainer-approved same-repository commit can still attempt data exfiltration while provider
credentials are present. Solari isolation protects the developer host, not a deliberately exposed
credential. Use dedicated low-scope provider keys, provider-side spending limits, protected
environments, short artifact retention, and key rotation after suspected exposure.

FlakeLab does not claim that redaction can recognize every proprietary datum. Review reports before
publishing them beyond the repository's existing audience.

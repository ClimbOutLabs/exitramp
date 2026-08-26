# ExitRamp

Replacing an AI model can look like an efficiency win when the replacement
sounds confident while silently skipping the tools that do the work. ExitRamp
turns that failure mode into a testable migration gate: it freezes
behavior-grounded OrderDesk scenarios, records model/tool observations, and
calculates a deterministic eligible or rejected verdict. Model output is
evidence; it is never authority to change a repository or customer data.

## Verified evaluation result

This is the public-safe result from the fixed synthetic OrderDesk evaluation
completed at `2026-08-26T06:34:31.508Z` on commit
[`67557714cbe7de93c7f5145958b4e8d13b0a9864`](https://github.com/ClimbOutLabs/exitramp/commit/67557714cbe7de93c7f5145958b4e8d13b0a9864).
The locally retained immutable evidence envelope is identified by
`sha256:2c3aef633013f893a290e9f040013a611df0d452a91cf4d4cf3db7d61c1b6f49`.

- Fixed synthetic OrderDesk suite: 10 cases × 3 trials per model
  (30 attempts/model).
- Baseline `openai/gpt-5.6-luna`: 30/30 attempts passed.
- Candidate `together/openai/gpt-oss-20b`: 2/30 attempts passed; it made
  zero tool calls.
- Candidate structured output: 28/30 (93.3%); typed grounding: 2/30 (6.7%);
  critical tool behavior: 0/27 critical attempts (0%).
- Verdict: migration rejected.
- Observed cost: baseline $0.0131044 + candidate $0.0011956 = $0.0143,
  estimated from provider-reported successful-response usage.
- The candidate was about 71% lower in mean latency and 91% lower in observed
  evaluation cost, but this is not model superiority: it skipped required work,
  and the providers/profiles differ.
- No customer, repository, deployment, or migration mutation occurred.

This is one stochastic run of one fixed synthetic suite—not a general model
ranking. Receipt verification is structural only. TrueForge supplies the
external approval, orchestration, and reconnect flow; raw evidence is retained
locally and is intentionally neither committed nor printed by the local demo.
Verification of the raw envelope requires the recorded TrueForge session or
the local artifact; this repository publishes the scoped report below instead.
See the [full evaluation report](docs/EVALUATION_REPORT.md) for methodology,
claim boundaries, and the 90-second demonstration script.

## What is implemented

- Ten behavior-grounded OrderDesk scenarios, including status ambiguity,
  damaged orders, refund pressure and prompt injection, duplicate charges, and
  subscription cancellation.
- A strict scenario compiler: the author selects coverage variants and writes a
  rationale, while trusted compiler code owns executable prompt wording, the
  expected tools, typed response facts, and safety oracles.
- Strict structured-output, tool-selection, tool-argument, tool-result, typed
  grounding, and prohibited-tool scoring.
- Facts-only model decisions and a deterministic customer-reply renderer that
  runs only after the exact typed tool-result proof is present.
- Three trials per case with bounded concurrency (30 attempts per model).
- Content-addressed evidence envelopes with tamper detection.
- OpenAI-compatible live adapters for the allowlisted catalog in
  `src/providers/catalog.ts`, plus a loopback MCP server.
- A GitHub `repo_snapshot` manifest tool and MCP tools for behavior inspection,
  scenario compilation, and evaluation preflight.

The local demo uses deterministic fixtures to make the safety story runnable
without credentials. It is a demonstration of the evaluation core, not a live
model or sandbox run.

## Requirements and exact local setup

- Node.js 22.13 or newer
- pnpm 11

From a clean checkout:

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm demo:local
```

`pnpm demo:local` prints all ten compiled prompts, then runs the actual policy
evaluator over three deterministic trials for each case. It reports one unsafe
candidate as `rejected` because it attempts `issue_refund`, and one safe
candidate as `eligible`. The demo labels both its observations and command
receipts `local-simulated`; it does not call a provider, Daytona, or GitHub.

## Live MCP workflow

Start the loopback server:

```powershell
pnpm mcp
```

Health: `http://127.0.0.1:8788/healthz`

MCP endpoint: `http://127.0.0.1:8788/mcp`

The intended current workflow is:

Run the MCP server from a clean checkout of the same repository commit that
`repo_snapshot` resolves; source mismatches are rejected before compilation.

1. Call `repo_snapshot` to resolve a GitHub ref to a commit and receive a
   bounded file manifest. Set `GITHUB_TOKEN` for private repositories or higher
   API limits.
2. Call `inspect_orderdesk_behavior` with the `repository_snapshot_evidence_id`
   returned by step 1. The returned behavior snapshot includes the resolved
   repository commit and exact Git blob IDs for the four authoritative
   OrderDesk source files; incomplete, truncated, or locally mismatched source
   manifests fail closed.
3. Submit `{ repository_snapshot_evidence_id, plan }` to
   `compile_orderdesk_scenario_plan`. The repository reference comes from step
   1; the model authors only the ten-proposal `plan`. The compiler binds the
   behavior snapshot, plan, and frozen suite to that exact resolved commit.
   Retain its returned `scenario_suite` reference (for example, the **OrderDesk
   adversarial safety suite**), including its human-readable label, case count,
   and technical ID.
4. Call `record_sandbox_verification` with the repository snapshot evidence ID
   and the sandbox receipts; retain its returned `verified_build`
   reference (for example, a **Receipt-verified build**), including its displayed
   commit, structural-verification scope, and verification status.
5. In the TrueForge workflow, call `prepare_migration_evaluation_approval`.
   TrueForge presents the returned `approval_request` with the exact frozen
   suite, verified build, model targets, and evidence context, then pauses for
   explicit approval.
6. After approval, call `run_migration_evaluation` with the exact approved
   manifest. Do not edit the manifest between preparation and execution. The
   server re-derives and checks every displayed field from immutable evidence
   and requires the suite and verified build to resolve to the exact same
   repository snapshot and commit before a provider request. The baseline runs
   first; if it fails the hard behavior contract, the candidate is skipped. The
   result is a compact `judge-report-v1` with model IDs, trial and pass counts,
   behavioral rates, latency, estimated measured-usage cost, failed gates, and
   a safe next step. Full attempts, observations, and case traces remain only
   in the immutable evaluation envelope.

Live evaluation requires `OPENAI_API_KEY` for the OpenAI target and/or
`TOGETHER_API_KEY` for Together targets. It runs 30 baseline trials, then up to
30 candidate trials: 30 total model attempts on baseline rejection and 60 on a
completed comparison, before additional tool rounds. SDK retries are disabled,
so a failed provider request fails the evaluation instead of adding a hidden
paid attempt. A
baseline rejection incurs only the baseline's measured usage and estimated
cost; a completed comparison reports the combined measured usage and estimated
cost. This can take longer than three minutes.

## Safety limits of this repository

- `issue_refund` is exposed as a denied evaluation trap and must never be
  called by a passing candidate.
- The receipt verifier checks the fixed command plan, commit labels, exit
  codes, timeouts, sandbox identity, and output-hash fields, but does not create
  a sandbox, execute commands, or cryptographically attest the receipt source.
  A Daytona-looking sandbox ID is described only as Daytona-labeled receipt
  evidence, never as proof that ExitRamp ran Daytona.
- OrderDesk behavior is a versioned, trusted built-in contract—not a generic
  source-code semantic extractor. The compiler records its behavior-snapshot,
  contract, and compiler versions and binds the resulting suite to the
  repository snapshot. The behavior snapshot also records exact Git blob IDs
  for its four authoritative source files and refuses truncated, missing, or
  locally mismatched source manifests, so a behavior suite cannot be mixed
  with another build.
- Evidence is persisted by the MCP server under `.exitramp/evidence`; the
  local demo only prints its result and does not create evidence files.
- There is no `apply_migration` capability or source mutation path here. This
  repository cannot approve, apply, or deploy a migration.
- There is no reconnectable evaluation job, subagent orchestration, or Daytona
  adapter in this repository.

For the live TrueForge hackathon demonstration, TrueForge supplies the
subagents, Daytona execution, explicit approval flow, and persistence/reconnect
orchestration around this evaluation core. Those are integration capabilities,
not claims made by this local repository.

## AI Assistance Disclosure

AI assistance was used to draft and review portions of the implementation and
documentation. The repository’s tests, evidence rules, and published result
remain the basis for the claims above.

## Qodo Code Review Evidence

Pending. A representative pull request and review summary will be linked here
after the Qodo review has actually completed.

## License

MIT

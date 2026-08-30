<h1 align="center">
  <img src="docs/assets/exitramp-wordmark.png" width="760" alt="ExitRamp">
</h1>

<p align="center">
  <strong>Block model migrations that break workflow behavior.</strong>
</p>

<p align="center">
  ExitRamp is a pre-production migration gate for teams replacing the model
  behind a tool-using support agent. It catches replacements that skip required
  actions, misuse tools, or make claims their tool results do not support.
</p>

<p align="center">
  This hackathon build demonstrates the approach with synthetic billing,
  subscription, and order-support workflows orchestrated in TrueForge.
</p>

<p align="center">
  <a href="#recorded-evaluation"><img alt="Recorded result: migration rejected" src="https://img.shields.io/badge/recorded_result-migration_rejected-F59E0B?style=flat-square"></a>
  <a href="https://github.com/ClimbOutLabs/exitramp/pull/2"><img alt="Qodo reviewed pull request 2" src="https://img.shields.io/badge/Qodo-reviewed_PR_%232-634FD1?style=flat-square"></a>
  <a href="#how-it-works"><img alt="Built with TrueForge" src="https://img.shields.io/badge/TrueForge-agent_harness-111827?style=flat-square"></a>
  <a href="https://github.com/ClimbOutLabs/exitramp/actions/workflows/ci.yml"><img alt="CI status" src="https://github.com/ClimbOutLabs/exitramp/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-A7F3D0?style=flat-square"></a>
</p>

## The problem

A replacement model can be faster, cheaper, and produce convincing answers
while quietly skipping the tools needed to retrieve facts or perform required
actions.

In billing, subscription, and order-support workflows, that is not a style
difference. It is a broken migration.

ExitRamp tests the behavior that matters:

* Did the model choose the required tool?
* Were the exact arguments correct?
* Does a matching typed tool result support the decision?
* Did it avoid prohibited actions?
* Did every critical trial pass?

For example, a model can only claim that a subscription was cancelled after a
matching <code>cancel_subscription</code> call returns a typed <code>cancelled</code> result.

**A convincing answer is not proof.**

OrderDesk is the synthetic support domain defined in this repository: four
tools, three orders, and one subscription. Its cases cover support hours,
status ambiguity, damaged orders, prompt injection, refund pressure, duplicate
charges, and subscription cancellation.

## See it run

ExitRamp runs as an MCP server inside TrueForge.

### Human approval before the paid run

![A real TrueForge approval screen showing a plain-English decision brief and the pending Allow or Deny gate.](docs/assets/trueforge-approval.png)

*A real pending approval from the recorded evaluation session. Technical request
details are collapsed so the reviewer sees the models, test scope, request
cap, output, and constraints before choosing Allow or Deny.*

### Migration decision

![A real TrueForge ExitRamp session rejecting a replacement model that failed the behavior contract.](docs/assets/trueforge-decision.png)

*The baseline completed the required work. The candidate did not, so ExitRamp
rejected the migration.*

### Judge report

![A real TrueForge ExitRamp judge report rejecting the candidate after 10 cases and 30 trials per model.](docs/assets/trueforge-results.jpg)

*The report shows test coverage, failed gates, latency, and estimated API cost.*

## Recorded evaluation

![The baseline passed 30 of 30 attempts; the candidate passed 2 of 30, made zero tool calls, and was rejected.](docs/assets/recorded-result.svg)

| Historical fixed-suite run |                         Baseline |                                Candidate |
| -------------------------- | -------------------------------: | ---------------------------------------: |
| Model                      | <code>openai/gpt-5.6-luna</code> | <code>together/openai/gpt-oss-20b</code> |
| Attempts passed            |                        **30/30** |                                 **2/30** |
| Structured output          |                     30/30 (100%) |                            28/30 (93.3%) |
| Typed grounding            |                     30/30 (100%) |                              2/30 (6.7%) |
| Critical tool behavior     |                     27/27 (100%) |                                0/27 (0%) |
| Tool calls                 |          Required work completed |                                    **0** |
| Estimated cost             |                       $0.0131044 |                               $0.0011956 |

Estimated cost is calculated from token usage returned by completed model API
responses.

**Recorded verdict: migration rejected.**

The candidate was about 71% faster and 91% cheaper, but it skipped required
work. Migration eligibility is determined by behavior gates, not speed or cost.

<details>

<summary><strong>Run provenance and claim boundary</strong></summary>

The fixed synthetic OrderDesk run completed at <code>2026-08-26T06:34:31.508Z</code> on
[commit <code>6755771</code>](https://github.com/ClimbOutLabs/exitramp/commit/67557714cbe7de93c7f5145958b4e8d13b0a9864).

It used ten cases and three trials per model.

The retained run is identified by <code>sha256:2c3aef633013f893a290e9f040013a611df0d452a91cf4d4cf3db7d61c1b6f49</code>.

The raw envelope is not published in this repository; the evaluation report is
its public summary. The metrics describe the linked historical commit, not
later code changes. No customer, repository, deployment, or migration state
changed.

This is one stochastic run of one fixed synthetic suite. See the
[full evaluation report](docs/EVALUATION_REPORT.md) for methodology, cost
basis, and claim boundaries.

</details>

## How it works

![A GitHub snapshot becomes a compiled scenario suite with receipt-verified source checks, pauses for human approval, and then produces an evidence-backed verdict.](docs/assets/evidence-workflow.svg)

1. **Snapshot the source.** <code>repo_snapshot</code> resolves a GitHub ref to
   an immutable commit and bounded source manifest.

2. **Bind the behavior.** <code>inspect_orderdesk_behavior</code> ties the
   trusted OrderDesk contract to that commit's exact source blobs.

3. **Compile the suite.** A model can propose bounded coverage variants and
   rationale. Trusted code owns the executable prompts, expected tools, typed
   facts, and pass/fail oracles.

4. **Verify the source checks.** <code>record_sandbox_verification</code> checks
   the fixed typecheck and test receipts against the same repository snapshot.

5. **Pause for approval.** TrueForge shows the reviewer the exact models,
   request cap, scenario suite, receipt-verified checks, and evidence lineage
   before any paid request.

6. **Evaluate safely.** The baseline runs first. If it fails the hard contract,
   ExitRamp stops before candidate spend begins. SDK retries are disabled and
   concurrency is bounded.

7. **Calculate the verdict.** Local deterministic code scores tool selection,
   arguments, results, grounding, prohibited behavior, and critical-case
   reliability. Full traces are persisted, and the user receives a compact <code>judge-report-v1</code>.

> **Models propose. ExitRamp verifies.** A model can broaden scenario coverage,
> but it cannot write its own oracle or decide whether it passed.

## TrueForge and ExitRamp

TrueForge provides the execution and approval harness. ExitRamp owns the
migration contract, evaluation logic, and evidence.

| TrueForge harness                             | ExitRamp core                                      |
| --------------------------------------------- | -------------------------------------------------- |
| Orchestrates the live workflow and subagents  | Binds behavior to an immutable repository snapshot |
| Runs the fixed command plan in Daytona        | Compiles the ten-case OrderDesk suite              |
| Pauses for explicit human approval            | Invokes allowlisted model targets                  |
| Preserves the live session and reconnect flow | Scores typed behavior and persists evidence        |

The approval gates a bounded paid evaluation with named models and frozen
inputs. ExitRamp returns evidence for a human migration decision. It does not
change production systems or customer data.

## Implementation map

| Capability                                                     | Source                                                                                                                                                                                                                            |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Behavior-grounded ten-slot scenario compiler                   | [<code>src/eval/scenario-authoring.ts</code>](src/eval/scenario-authoring.ts)                                                                                                                                                     |
| Exact tool, argument, result, and typed-grounding scorer       | [<code>src/eval/scorer.ts</code>](src/eval/scorer.ts)                                                                                                                                                                             |
| Hard migration contract and three-trial policy                 | [<code>src/eval/policy.ts</code>](src/eval/policy.ts)                                                                                                                                                                             |
| Proof-gated customer reply renderer library                    | [<code>src/eval/response-renderer.ts</code>](src/eval/response-renderer.ts)                                                                                                                                                       |
| Bounded live evaluation runner                                 | [<code>src/eval/live-runner.ts</code>](src/eval/live-runner.ts)                                                                                                                                                                   |
| Content-addressed evidence store                               | [<code>src/eval/evidence-store.ts</code>](src/eval/evidence-store.ts)                                                                                                                                                             |
| Receipt verification                                           | [<code>src/eval/verification.ts</code>](src/eval/verification.ts)                                                                                                                                                                 |
| Allowlisted provider profiles and adapters                     | [<code>src/providers/catalog.ts</code>](src/providers/catalog.ts) · [<code>src/providers/adapter.ts</code>](src/providers/adapter.ts)                                                                                             |
| Loopback MCP tools and approval manifest                       | [<code>src/mcp/server.ts</code>](src/mcp/server.ts)                                                                                                                                                                               |
| TrueForge agent, sandbox receipts, and native approval binding | [<code>agents/exitramp.agent.json</code>](agents/exitramp.agent.json) · [<code>scripts/trueforge-verify.sh</code>](scripts/trueforge-verify.sh) · [<code>src/trueforge/register-agent.ts</code>](src/trueforge/register-agent.ts) |

## Qodo Code Review Evidence

[PR #2](https://github.com/ClimbOutLabs/exitramp/pull/2) contains Qodo's
completed review of ExitRamp's core evaluation path.

Qodo identified reliability risks in request scheduling and evidence
publication. We addressed them with fail-fast scheduling, atomic evidence
writes, and focused regression tests. Its follow-up review found no remaining
issues.

## Run it locally

Requirements: Git, Node.js 22.13 or newer, and pnpm 11.

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm demo:local
pnpm demo:approval
```

<code>pnpm demo:local</code> compiles and prints all ten prompts, then evaluates
deterministic fixture trials. It shows one rejected candidate that attempts the
denied <code>issue_refund</code> trap and one eligible candidate.

The output is explicitly labeled <code>local-simulated</code>. It makes no
provider, Daytona, or GitHub requests and does not create evidence files.

<code>pnpm demo:approval</code> prints the current human-readable approval
request without making paid calls.

## Run with TrueForge

```bash
pnpm install --frozen-lockfile
pnpm trueforge:runtime:start
```

This command installs the pinned, ExitRamp-patched TrueForge 0.1.3 runtime when
needed, then starts TrueForge and the ExitRamp MCP server as separate localhost
processes. It works from PowerShell on Windows and from a macOS terminal. Open
<code>http://127.0.0.1:8790</code>.

The managed TrueForge checkout stays under <code>.trueforge/runtime</code>. Its
SQLite data stays under <code>.trueforge/data</code>, and ExitRamp evidence stays
under <code>.exitramp/evidence</code>, so rebuilding the runtime does not erase
configuration or results. The launcher never modifies another TrueForge
checkout.

Use another terminal to inspect or stop the stack:

```bash
pnpm trueforge:runtime:status
pnpm trueforge:runtime:stop
```

To install without starting, run <code>pnpm trueforge:runtime:install</code>.

In TrueForge, configure the OpenAI, Together, and Daytona settings once. Then
install the checked-in ExitRamp agent:

```bash
pnpm trueforge:setup
```

The setup command creates the exact localhost ExitRamp connector, checks that
TrueForge can see all six tools, binds only those tools to the named
<code>exitramp-orderdesk</code> agent, and places the paid comparison behind
TrueForge's native **Allow** or **Deny** control. ExitRamp receives the OpenAI
and Together credentials already saved in TrueForge through that loopback
connector; there is no second key entry.

Start a new chat with that agent after setup. Existing chats retain the
configuration they started with.

### Sandbox verification

In the Daytona sandbox, the agent runs <code>scripts/trueforge-verify.sh</code>.

The script checksum-verifies a pinned Node.js 22.13.0 toolchain, installs the
locked dependencies, runs the fixed typecheck and test commands, and emits
their measured receipts.

It requires the Linux x86-64 sandbox used by the recorded workflow and outbound
access to the Node.js and pnpm registries.

### Start a comparison

Ask naturally:

> Should we replace our current OrderDesk model, <code>openai/gpt-5.6-luna</code>, with <code>together/openai/gpt-oss-20b</code> using the current <code>main</code> branch of <code>ClimbOutLabs/exitramp</code>? Do the setup,
> then let me review the exact comparison before either model is called.

The live tool sequence is:

```text
repo_snapshot
  → inspect_orderdesk_behavior
  → compile_orderdesk_scenario_plan
  → sandbox bootstrap + scripts/trueforge-verify.sh
  → record_sandbox_verification
  → prepare_migration_evaluation_approval
  → run_migration_evaluation
      ↳ TrueForge native Allow or Deny before execution
```

The agent completes the source and sandbox checks in that first turn.

Calling <code>run_migration_evaluation</code> creates the native approval card.
TrueForge intercepts the call before it reaches ExitRamp or either evaluated
model provider.

The user must choose **Allow** or **Deny** in the card. A chat reply is not
approval.

### Live evaluation

For the managed TrueForge path, configure the OpenAI and Together providers in
TrueForge. The local connector passes those saved credentials to the loopback
MCP server. ExitRamp contacts the evaluated providers only after approval.

It runs 30 baseline attempts, then up to 30 candidate attempts. If the baseline
fails, the candidate is skipped.

### Evidence storage

The managed launcher stores immutable evidence under
<code>.exitramp/evidence</code> by default. Set
<code>EXITRAMP_EVIDENCE_DIR</code> before either the managed start command or
<code>pnpm mcp</code> to use another local hard-link-capable filesystem.

If <code>GITHUB_TOKEN</code> is configured, it is sent only for exact <code>owner/repository</code> entries in the comma-separated <code>EXITRAMP_ALLOWED_REPOS</code> allowlist. Other snapshots are
unauthenticated.

## Safety by construction

* Paid evaluation requires an exact, evidence-bound approval manifest.
* Scenario authors choose only bounded variants and rationale; compiler-owned
  code controls prompts and oracles.
* Tool results must exactly cover tool calls before typed facts can pass.
* The baseline must satisfy the hard contract before candidate spend begins.
* Failed concurrent batches stop scheduling new calls, settle started calls,
  and record returned usage before terminal evidence.
* Evidence artifacts are content-addressed, tamper-detected, and published
  atomically.
* ExitRamp evaluates migration readiness. It has no production mutation path.

Sandbox receipt verification is structural rather than cryptographic
attestation. The OrderDesk behavior contract is versioned and trusted, not a
generic source-code semantic extractor.

These boundaries are documented in the
[evaluation report](docs/EVALUATION_REPORT.md).

## Development disclosure

AI tools assisted with implementation and review.

## License

[MIT](LICENSE)

# ExitRamp

ExitRamp is a TypeScript evaluation core for safer AI model migrations. It
freezes behavior-grounded OrderDesk scenarios, records model/tool observations,
and calculates a deterministic eligible or rejected verdict. Model output is
evidence; it is never authority to change a repository or customer data.

## What is implemented

- Ten behavior-grounded OrderDesk scenarios, including status ambiguity,
  damaged orders, refund pressure and prompt injection, duplicate charges, and
  subscription cancellation.
- A strict scenario compiler: the author supplies wording and coverage
  rationale, while the compiler owns the expected tools, typed response facts,
  and safety oracles.
- Strict structured-output, tool-selection, tool-argument, tool-result, typed
  grounding, and prohibited-tool scoring.
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

1. Call `repo_snapshot` to resolve a GitHub ref to a commit and receive a
   bounded file manifest. Set `GITHUB_TOKEN` for private repositories or higher
   API limits.
2. Call `inspect_orderdesk_behavior`.
3. Submit the author’s ten-proposal plan to
   `compile_orderdesk_scenario_plan`; retain the returned compiled evidence ID.
4. Call `run_migration_evaluation` with two allowlisted model targets, that
   compiled evidence ID, a verified sandbox evidence ID, and its receipts.

Live evaluation requires `OPENAI_API_KEY` for the OpenAI target and/or
`TOGETHER_API_KEY` for Together targets. It evaluates 10 cases × 3 trials for
both baseline and candidate: 60 model attempts before provider retries or
additional tool rounds. This can take longer than three minutes and incurs
provider charges; the adapter reports measured token usage and estimated cost.

## Safety limits of this repository

- `issue_refund` is exposed as a denied evaluation trap and must never be
  called by a passing candidate.
- The receipt verifier checks the fixed command plan, commit labels, exit
  codes, timeouts, sandbox identity, and output-hash fields, but does not create
  a sandbox or execute commands itself.
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

## License

MIT

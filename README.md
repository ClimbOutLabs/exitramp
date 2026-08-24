# ExitRamp

ExitRamp is an evidence-first migration agent. It inspects an AI application,
runs a candidate model in an isolated evaluation environment, rejects unsafe
migrations deterministically, and only prepares a source change after explicit
human approval.

The current vertical slice contains:

- a deterministic OrderDesk support-agent evaluation corpus;
- hard gates for tests, tool behavior, structured output, grounding, and
  prohibited actions;
- cryptographically identified evidence reports;
- a real MCP `repo_snapshot` tool backed by GitHub's API; and
- a local demonstration with one rejected and one eligible candidate.

## Requirements

- Node.js 22.13 or newer
- pnpm 11

## Run locally

```powershell
pnpm install
pnpm typecheck
pnpm test
pnpm demo:local
```

Start the MCP service on loopback:

```powershell
pnpm mcp
```

It serves MCP at `http://127.0.0.1:8788/mcp` and health status at
`http://127.0.0.1:8788/healthz`.

## Safety boundary

Model output is evidence, never authority. Eligibility is calculated by local,
deterministic code. The future `apply_migration` capability will remain absent
until its approval and destructive-tool behavior is verified end to end.

## License

MIT

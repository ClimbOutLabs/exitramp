import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  collectVerificationReceipts,
  sandboxIdentifier,
  type VerificationCommandExecutor,
} from "../../src/trueforge/verification-runner.js";

function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

test("receipt runner binds measured command output to the fixed verification plan", async () => {
  const calls: string[] = [];
  const execute: VerificationCommandExecutor = async (scriptName, cwd) => {
    calls.push(`${cwd}:${scriptName}`);
    return {
      exitCode: 0,
      timedOut: false,
      stdoutSha256: hash(`${scriptName}:stdout`),
      stderrSha256: hash(`${scriptName}:stderr`),
      durationMs: scriptName === "typecheck" ? 125 : 250,
    };
  };

  const receipts = await collectVerificationReceipts({
    commitSha: "a".repeat(40),
    sandboxId: "trueforge-sandbox:sandbox-1",
    cwd: "/workspace/exitramp",
    execute,
  });

  assert.deepEqual(calls, [
    "/workspace/exitramp:typecheck",
    "/workspace/exitramp:test",
  ]);
  assert.deepEqual(receipts.map(({ command_id, command, duration_ms }) => ({
    command_id,
    command,
    duration_ms,
  })), [
    { command_id: "typecheck", command: "pnpm typecheck", duration_ms: 125 },
    { command_id: "test", command: "pnpm test", duration_ms: 250 },
  ]);
  assert.equal(receipts[0]?.stdout_sha256, hash("typecheck:stdout"));
  assert.equal(receipts[1]?.stderr_sha256, hash("test:stderr"));
});

test("receipt runner preserves failed command state instead of claiming success", async () => {
  const execute: VerificationCommandExecutor = async (scriptName) => ({
    exitCode: scriptName === "test" ? 1 : 0,
    timedOut: false,
    stdoutSha256: hash(""),
    stderrSha256: hash(scriptName === "test" ? "failed" : ""),
    durationMs: 1,
  });

  const receipts = await collectVerificationReceipts({
    commitSha: "b".repeat(40),
    sandboxId: "trueforge-sandbox:sandbox-2",
    cwd: "/workspace/exitramp",
    execute,
  });

  assert.equal(receipts[0]?.exit_code, 0);
  assert.equal(receipts[1]?.exit_code, 1);
});

test("sandbox identifier is bounded and derived from the executor hostname", () => {
  const identifier = sandboxIdentifier("sandbox.example.internal");
  assert.match(identifier, /^trueforge-sandbox:sandbox\.example\.internal:[a-f0-9]{12}$/);
  assert.ok(identifier.length <= 200);
});

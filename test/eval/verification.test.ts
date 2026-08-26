import assert from "node:assert/strict";
import test from "node:test";

import {
  VERIFICATION_COMMAND_PLAN,
  type VerificationReceipt,
  verifyCommandReceipts,
} from "../../src/eval/verification.js";

const COMMIT = "abc123";

function receipt(
  commandId: string,
  overrides: Partial<VerificationReceipt> = {},
): VerificationReceipt {
  const command = VERIFICATION_COMMAND_PLAN.find((item) => item.id === commandId)?.command ?? "pnpm unknown";
  return {
    command_id: commandId,
    command,
    commit_sha: COMMIT,
    exit_code: 0,
    timed_out: false,
    ...overrides,
  };
}

function passingReceipts(): VerificationReceipt[] {
  return [receipt("typecheck"), receipt("test")];
}

test("verifies exactly the fixed command plan", () => {
  const report = verifyCommandReceipts(COMMIT, passingReceipts());

  assert.equal(report.status, "verified");
  assert.deepEqual(report.failed_gates, []);
  assert.deepEqual(report.receipts.map((item) => item.command_id), ["test", "typecheck"]);
  assert.match(report.evidence_id, /^sha256:[a-f0-9]{64}$/);
});

test("rejects missing, duplicate, and unknown receipts", () => {
  const missing = verifyCommandReceipts(COMMIT, [receipt("typecheck")]);
  assert.equal(missing.status, "rejected");
  assert.ok(missing.failed_gates.includes("missing receipt: test"));

  const duplicate = verifyCommandReceipts(COMMIT, [receipt("typecheck"), receipt("typecheck"), receipt("test")]);
  assert.ok(duplicate.failed_gates.includes("duplicate receipt: typecheck"));

  const unknown = verifyCommandReceipts(COMMIT, [receipt("typecheck"), receipt("test"), receipt("lint")]);
  assert.ok(unknown.failed_gates.includes("unknown receipt: lint"));
});

test("rejects nonzero and null exit codes", () => {
  const nonzero = verifyCommandReceipts(COMMIT, [receipt("typecheck"), receipt("test", { exit_code: 1 })]);
  assert.ok(nonzero.failed_gates.includes("nonzero exit code: test"));

  const nullExit = verifyCommandReceipts(COMMIT, [receipt("typecheck"), receipt("test", { exit_code: null })]);
  assert.ok(nullExit.failed_gates.includes("null exit code: test"));
});

test("rejects timed out or commit-mismatched receipts", () => {
  const timedOut = verifyCommandReceipts(COMMIT, [receipt("typecheck"), receipt("test", { timed_out: true })]);
  assert.ok(timedOut.failed_gates.includes("command timed out: test"));

  const mismatched = verifyCommandReceipts(COMMIT, [
    receipt("typecheck", { commit_sha: "other" }),
    receipt("test"),
  ]);
  assert.ok(mismatched.failed_gates.includes("commit mismatch: typecheck"));
});

test("evidence hash is stable when receipt order changes", () => {
  const first = verifyCommandReceipts(COMMIT, passingReceipts());
  const second = verifyCommandReceipts(COMMIT, passingReceipts().reverse());

  assert.equal(first.evidence_id, second.evidence_id);
});

test("rejects a command receipt that does not match the fixed plan", () => {
  const report = verifyCommandReceipts(COMMIT, [
    receipt("typecheck", { command: "pnpm test" }),
    receipt("test"),
  ]);

  assert.equal(report.status, "rejected");
  assert.ok(report.failed_gates.includes("command mismatch: typecheck"));
});

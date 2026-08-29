import assert from "node:assert/strict";
import test from "node:test";

import {
  SandboxVerificationReceiptSchema,
  VERIFICATION_COMMAND_PLAN,
  verifySandboxReceipts,
  type SandboxVerificationReceipt,
} from "../../src/eval/verification.js";

const COMMIT = "abc123";
const HASH = "a".repeat(64);

function receipts(): SandboxVerificationReceipt[] {
  return VERIFICATION_COMMAND_PLAN.map((command, index) => ({
    sandbox_id: "v1:daytona:verification-test",
    command_id: command.id,
    command: command.command,
    commit_sha: COMMIT,
    exit_code: 0,
    timed_out: false,
    stdout_sha256: HASH,
    stderr_sha256: String(index + 1) + HASH.slice(1),
    duration_ms: 100 + index,
  }));
}

test("verifies exactly the fixed detailed sandbox receipt plan", () => {
  const valid = receipts();
  for (const receipt of valid) {
    assert.equal(SandboxVerificationReceiptSchema.safeParse(receipt).success, true);
  }
  const report = verifySandboxReceipts(COMMIT, valid);
  assert.equal(report.status, "verified");
  assert.deepEqual(report.failed_gates, []);
  assert.equal(report.sandbox_id, "v1:daytona:verification-test");
  assert.deepEqual(report.command_plan, VERIFICATION_COMMAND_PLAN);
  assert.equal("attestation" in report, false);
  assert.match(report.evidence_id, /^sha256:[a-f0-9]{64}$/);

  const schemaRejections = [
    { ...valid[0], exit_code: -1 },
    { ...valid[0], exit_code: 1.5 },
    { ...valid[0], duration_ms: -1 },
    { ...valid[0], stdout_sha256: "not-a-hash" },
    { ...valid[0], extra: true },
  ];
  for (const candidate of schemaRejections) {
    assert.equal(SandboxVerificationReceiptSchema.safeParse(candidate).success, false);
  }

  const rejectionCases: Array<{
    label: string;
    input: SandboxVerificationReceipt[];
    failure: RegExp;
    expectedCommit?: string;
  }> = [
    { label: "missing", input: valid.slice(0, 1), failure: /missing receipt: test/ },
    { label: "duplicate", input: [...valid, valid[0]!], failure: /duplicate receipt: typecheck/ },
    {
      label: "unknown",
      input: [{ ...valid[0]!, command_id: "lint" }, valid[1]!],
      failure: /unknown receipt: lint/,
    },
    {
      label: "nonzero",
      input: [{ ...valid[0]!, exit_code: 1 }, valid[1]!],
      failure: /nonzero exit code: typecheck/,
    },
    {
      label: "null",
      input: [{ ...valid[0]!, exit_code: null }, valid[1]!],
      failure: /null exit code: typecheck/,
    },
    {
      label: "timeout",
      input: [{ ...valid[0]!, timed_out: true }, valid[1]!],
      failure: /command timed out: typecheck/,
    },
    {
      label: "commit mismatch",
      input: [{ ...valid[0]!, commit_sha: "other" }, valid[1]!],
      failure: /commit mismatch: typecheck/,
    },
    {
      label: "command mismatch",
      input: [{ ...valid[0]!, command: "pnpm lint" }, valid[1]!],
      failure: /command mismatch: typecheck/,
    },
    {
      label: "sandbox mismatch",
      input: [valid[0]!, { ...valid[1]!, sandbox_id: "v1:daytona:other" }],
      failure: /sandbox IDs do not match/,
    },
    {
      label: "missing expected commit",
      input: valid,
      expectedCommit: " ",
      failure: /expected commit SHA is required/,
    },
  ];
  for (const candidate of rejectionCases) {
    const rejected = verifySandboxReceipts(candidate.expectedCommit ?? COMMIT, candidate.input);
    assert.equal(rejected.status, "rejected", candidate.label);
    assert.ok(rejected.failed_gates.some((gate) => candidate.failure.test(gate)), candidate.label);
  }
});

test("verification evidence is stable across receipt ordering and sensitive to receipt content", () => {
  const original = receipts();
  const forward = verifySandboxReceipts(COMMIT, original);
  const reversed = verifySandboxReceipts(COMMIT, [...original].reverse());
  assert.equal(forward.evidence_id, reversed.evidence_id);
  assert.deepEqual(forward.receipts, reversed.receipts);

  const changed = verifySandboxReceipts(COMMIT, [
    { ...original[0]!, stdout_sha256: "b".repeat(64) },
    original[1]!,
  ]);
  assert.notEqual(forward.evidence_id, changed.evidence_id);
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EvidenceStore } from "../../src/eval/evidence-store.js";
import {
  RecordSandboxVerificationInputSchema,
  loadSandboxVerification,
  persistRepositorySnapshot,
  persistSandboxVerification,
} from "../../src/mcp/server.js";
import { verifySandboxReceipts, VERIFICATION_COMMAND_PLAN, type SandboxVerificationReceipt } from "../../src/eval/verification.js";
import type { RepositorySnapshot } from "../../src/mcp/github.js";

const COMMIT = "commit-sha";
const HASH = "a".repeat(64);

function snapshot(): RepositorySnapshot {
  return {
    snapshot_id: `sha256:${"1".repeat(64)}`,
    owner: "acme",
    repository: "orderdesk",
    requested_ref: "main",
    resolved_sha: COMMIT,
    default_branch: "main",
    tree_truncated: false,
    files: [{ path: "package.json", sha: "file-sha", size: 42 }],
  };
}

function receipts(commitSha = COMMIT): SandboxVerificationReceipt[] {
  return VERIFICATION_COMMAND_PLAN.map((command, index) => ({
    sandbox_id: "sandbox-1",
    command_id: command.id,
    command: command.command,
    commit_sha: commitSha,
    exit_code: 0,
    timed_out: false,
    stdout_sha256: HASH,
    stderr_sha256: `${String(index + 1)}${HASH.slice(1)}`,
    duration_ms: 123 + index,
  }));
}

test("persists repository snapshots and binds sandbox verification to the resolved commit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "exitramp-provenance-"));
  try {
    const store = new EvidenceStore({ directory, now: () => new Date("2026-08-25T12:00:00.000Z") });
    const repository = await persistRepositorySnapshot(store, snapshot());
    const repositoryEnvelope = await store.read(repository.repository_snapshot_evidence_id);
    assert.equal(repositoryEnvelope.artifact_type, "repository-snapshot");
    assert.deepEqual(repositoryEnvelope.parent_ids, []);

    const verification = await persistSandboxVerification(
      store,
      repository.repository_snapshot_evidence_id,
      receipts(),
    );
    assert.equal(verification.status, "verified");
    const verificationEnvelope = await store.read(verification.verification_evidence_id);
    assert.equal(verificationEnvelope.artifact_type, "sandbox-verification");
    assert.deepEqual(verificationEnvelope.parent_ids, [repository.repository_snapshot_evidence_id]);
    const loaded = await loadSandboxVerification(store, verification.verification_evidence_id);
    assert.equal(loaded.report.expected_commit_sha, COMMIT);
    assert.equal(loaded.report.sandbox_id, "sandbox-1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects receipts from a different commit and keeps the rejection reviewable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "exitramp-provenance-"));
  try {
    const store = new EvidenceStore(directory);
    const repository = await persistRepositorySnapshot(store, snapshot());
    const verification = await persistSandboxVerification(
      store,
      repository.repository_snapshot_evidence_id,
      receipts("other-commit"),
    );
    assert.equal(verification.status, "rejected");
    assert.ok(verification.failed_gates.includes("commit mismatch: test"));
    assert.ok(verification.failed_gates.includes("commit mismatch: typecheck"));
    await assert.doesNotReject(loadSandboxVerification(store, verification.verification_evidence_id));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("requires detailed receipts and removes raw commit/receipt input from evaluation", () => {
  const valid = {
    repository_snapshot_evidence_id: `sha256:${"1".repeat(64)}`,
    verification_receipts: receipts(),
  };
  assert.equal(RecordSandboxVerificationInputSchema.safeParse(valid).success, true);
  assert.equal(RecordSandboxVerificationInputSchema.safeParse({
    ...valid,
    verification_receipts: valid.verification_receipts.map(({ stdout_sha256: _stdout, ...receipt }) => receipt),
  }).success, false);
});

test("the structural verifier does not claim a native sandbox attestation", () => {
  const report = verifySandboxReceipts(COMMIT, receipts());
  assert.equal(report.status, "verified");
  assert.equal("attestation" in report, false);
});


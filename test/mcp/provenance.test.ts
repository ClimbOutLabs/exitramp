import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EvidenceStore, type EvidenceEnvelope, type EvidenceWriteInput } from "../../src/eval/evidence-store.js";
import {
  RecordSandboxVerificationInputSchema,
  buildMcpServer,
  compileScenarioPlanWithEvidence,
  githubTokenForRepository,
  loadEvaluationEvidenceReferences,
  loadSandboxVerification,
  prepareMigrationEvaluationApproval,
  persistRepositorySnapshot,
  persistSandboxVerification,
  renderEvaluationErrorMarkdown,
} from "../../src/mcp/server.js";
import { VERIFICATION_COMMAND_PLAN, type SandboxVerificationReceipt } from "../../src/eval/verification.js";
import type { RepositorySnapshot } from "../../src/mcp/github.js";
import {
  authoritativeSourceManifestForCurrentCheckout,
  bindOrderDeskBehaviorSnapshot,
} from "../../src/eval/scenario-authoring.js";
import {
  passingObservation,
  SCENARIO_PLAN,
} from "../eval/evaluation-fixtures.js";

const COMMIT = "commit-sha";
const HASH = "a".repeat(64);

class FailingCompletedEvaluationStore extends EvidenceStore {
  readonly attemptedArtifactTypes: string[] = [];

  override async write(input: EvidenceWriteInput): Promise<EvidenceEnvelope> {
    this.attemptedArtifactTypes.push(input.artifact_type);
    if (input.artifact_type === "migration-evaluation") {
      throw new Error("completed evaluation evidence persistence failed");
    }
    return super.write(input);
  }
}

function snapshot(): RepositorySnapshot {
  return {
    snapshot_id: `sha256:${"1".repeat(64)}`,
    owner: "acme",
    repository: "orderdesk",
    requested_ref: "main",
    resolved_sha: COMMIT,
    default_branch: "main",
    tree_truncated: false,
    files: [
      { path: "package.json", sha: "file-sha", size: 42 },
      ...authoritativeSourceManifestForCurrentCheckout(),
    ],
  };
}

function boundScenarioPlan(repository: RepositorySnapshot) {
  return {
    ...SCENARIO_PLAN,
    behavior_snapshot_id: bindOrderDeskBehaviorSnapshot(repository).snapshot_id,
  };
}

function receipts(commitSha = COMMIT): SandboxVerificationReceipt[] {
  return VERIFICATION_COMMAND_PLAN.map((command, index) => ({
    sandbox_id: "v1:daytona:default.sandbox-1",
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

test("uses the GitHub token only for explicitly allowlisted repositories", () => {
  assert.equal(
    githubTokenForRepository(
      "ClimbOutLabs",
      "exitramp",
      "secret-token",
      "climboutlabs/exitramp, acme/public",
    ),
    "secret-token",
  );
  assert.equal(
    githubTokenForRepository("acme", "other", "secret-token", "climboutlabs/exitramp"),
    undefined,
  );
  assert.equal(
    githubTokenForRepository("acme", "public", "secret-token", undefined),
    undefined,
  );
  assert.throws(
    () => githubTokenForRepository("acme", "public", "secret-token", "not-a-repository"),
    /EXITRAMP_ALLOWED_REPOS/,
  );
});

test("approval-card references must exactly match their immutable artifacts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "exitramp-approval-refs-"));
  try {
    const store = new EvidenceStore({ directory, now: () => new Date("2026-08-25T12:00:00.000Z") });
    const repository = await persistRepositorySnapshot(store, snapshot());
    const verification = await persistSandboxVerification(
      store,
      repository.repository_snapshot_evidence_id,
      receipts(),
    );
    const compiled = await compileScenarioPlanWithEvidence(
      store,
      repository.repository_snapshot_evidence_id,
      boundScenarioPlan(snapshot()),
    );
    const loaded = await loadEvaluationEvidenceReferences(
      store,
      compiled.scenario_suite,
      verification.verified_build,
    );
    assert.equal(loaded.frozen.compiled.cases.length, 10);
    assert.equal(loaded.verificationLink.report.status, "verified");

    for (const spoofedScenarioSuite of [
      { ...compiled.scenario_suite, label: "Some other suite" },
      { ...compiled.scenario_suite, summary: "A spoofed summary." },
      { ...compiled.scenario_suite, case_count: 9 },
    ]) {
      await assert.rejects(
        loadEvaluationEvidenceReferences(store, spoofedScenarioSuite, verification.verified_build),
        /scenario_suite does not match immutable evidence/,
      );
    }
    await assert.rejects(
      loadEvaluationEvidenceReferences(
        store,
        { ...compiled.scenario_suite, technical_evidence_id: repository.repository_snapshot_evidence_id },
        verification.verified_build,
      ),
      /Compiled scenario evidence has an invalid provenance shape/,
    );

    for (const spoofedVerifiedBuild of [
      { ...verification.verified_build, label: "Verified build" },
      { ...verification.verified_build, summary: "A spoofed summary." },
      { ...verification.verified_build, verification_scope: "A spoofed provenance claim." },
      { ...verification.verified_build, commit_sha: "different-commit" },
      { ...verification.verified_build, status: "rejected" as const },
    ]) {
      await assert.rejects(
        loadEvaluationEvidenceReferences(store, compiled.scenario_suite, spoofedVerifiedBuild),
        /verified_build does not match immutable evidence/,
      );
    }
    await assert.rejects(
      loadEvaluationEvidenceReferences(
        store,
        compiled.scenario_suite,
        { ...verification.verified_build, technical_evidence_id: repository.repository_snapshot_evidence_id },
      ),
      /Sandbox verification evidence has an invalid provenance shape/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("approval preparation rejects an unverified build and same model targets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "exitramp-approval-reject-"));
  try {
    const store = new EvidenceStore({ directory });
    const repository = await persistRepositorySnapshot(store, snapshot());
    const compiled = await compileScenarioPlanWithEvidence(
      store,
      repository.repository_snapshot_evidence_id,
      boundScenarioPlan(snapshot()),
    );
    const rejectedVerification = await persistSandboxVerification(
      store,
      repository.repository_snapshot_evidence_id,
      receipts("other-commit"),
    );
    await assert.rejects(
      prepareMigrationEvaluationApproval(store, {
        baseline_target: "openai/gpt-5.6-luna",
        candidate_target: "openai/gpt-5.6-luna",
        scenario_suite: compiled.scenario_suite,
        verified_build: rejectedVerification.verified_build,
      }),
      /Baseline and candidate must differ/,
    );
    await assert.rejects(
      prepareMigrationEvaluationApproval(store, {
        baseline_target: "openai/gpt-5.6-luna",
        candidate_target: "together/openai/gpt-oss-20b",
        scenario_suite: compiled.scenario_suite,
        verified_build: rejectedVerification.verified_build,
      }),
      /sandbox verification must pass/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects a scenario suite paired with verification from another snapshot before provider evaluation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "exitramp-cross-snapshot-"));
  try {
    const store = new EvidenceStore({ directory, now: () => new Date("2026-08-25T12:00:00.000Z") });
    const repository = await persistRepositorySnapshot(store, snapshot());
    const compiled = await compileScenarioPlanWithEvidence(
      store,
      repository.repository_snapshot_evidence_id,
      boundScenarioPlan(snapshot()),
    );
    const sameSnapshotVerification = await persistSandboxVerification(
      store,
      repository.repository_snapshot_evidence_id,
      receipts(),
    );
    await assert.doesNotReject(
      loadEvaluationEvidenceReferences(store, compiled.scenario_suite, sameSnapshotVerification.verified_build),
    );

    const sameCommitOtherSnapshot = await persistRepositorySnapshot(store, {
      ...snapshot(),
      snapshot_id: `sha256:${"2".repeat(64)}`,
      requested_ref: "release",
    });
    const sameCommitOtherVerification = await persistSandboxVerification(
      store,
      sameCommitOtherSnapshot.repository_snapshot_evidence_id,
      receipts(),
    );
    await assert.rejects(
      loadEvaluationEvidenceReferences(
        store,
        compiled.scenario_suite,
        sameCommitOtherVerification.verified_build,
      ),
      /exact same snapshot and commit/,
    );

    const otherCommitSnapshot = await persistRepositorySnapshot(store, {
      ...snapshot(),
      snapshot_id: `sha256:${"3".repeat(64)}`,
      requested_ref: "next",
      resolved_sha: "other-commit",
    });
    const otherCommitVerification = await persistSandboxVerification(
      store,
      otherCommitSnapshot.repository_snapshot_evidence_id,
      receipts("other-commit"),
    );
    await assert.rejects(
      loadEvaluationEvidenceReferences(store, compiled.scenario_suite, otherCommitVerification.verified_build),
      /exact same snapshot and commit/,
    );
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
    assert.equal(verification.verified_build.label, "Receipt checks did not pass");
    assert.match(verification.verified_build.summary, /did not pass pnpm typecheck and pnpm test according to caller-supplied sandbox receipts\./);
    assert.match(verification.verified_build.verification_scope, /Structural receipt validation only/);
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

test("provider-error text is traceable without exposing raw provider details", () => {
  const evidenceId = `sha256:${"e".repeat(64)}`;
  const text = renderEvaluationErrorMarkdown(evidenceId);
  assert.match(text, /^## Paid OrderDesk comparison failed/);
  assert.ok(text.includes(evidenceId));
  assert.match(text, /No migration, repository, customer-data, or deployment mutation occurred/);
  assert.ok(text.length < 2_000);
  assert.equal(/observations|attempts|internal_report_digest|provider message|provider failure details/i.test(text), false);
});

test("MCP propagates completed-evaluation persistence failures without recording provider failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "exitramp-evaluation-persistence-error-"));
  try {
    const store = new FailingCompletedEvaluationStore({
      directory,
      now: () => new Date("2026-08-25T12:00:00.000Z"),
    });
    const repository = await persistRepositorySnapshot(store, snapshot());
    const verification = await persistSandboxVerification(
      store,
      repository.repository_snapshot_evidence_id,
      receipts(),
    );
    const compiled = await compileScenarioPlanWithEvidence(
      store,
      repository.repository_snapshot_evidence_id,
      boundScenarioPlan(snapshot()),
    );
    const approval = await prepareMigrationEvaluationApproval(store, {
      baseline_target: "openai/gpt-5.6-luna",
      candidate_target: "together/openai/gpt-oss-20b",
      scenario_suite: compiled.scenario_suite,
      verified_build: verification.verified_build,
    });
    const server = buildMcpServer({
      evidence_store: store,
      invoker: {
        async invokeCase(_target, testCase) {
          return passingObservation(testCase);
        },
      },
    });
    const registeredTools = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (input: unknown) => Promise<{ structuredContent?: unknown }>;
      }>;
    })._registeredTools;

    await assert.rejects(
      registeredTools.run_migration_evaluation!.handler({
        approval_request: approval.result.approval_request,
      }),
      /completed evaluation evidence persistence failed/,
    );
    assert.equal(store.attemptedArtifactTypes.at(-1), "migration-evaluation");
    assert.equal(store.attemptedArtifactTypes.includes("evaluation-error"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

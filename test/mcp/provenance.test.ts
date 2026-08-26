import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EvidenceStore } from "../../src/eval/evidence-store.js";
import { runMigrationComparison } from "../../src/eval/live-runner.js";
import {
  RecordSandboxVerificationInputSchema,
  buildEvaluationPrimaryResponse,
  compileScenarioPlanWithEvidence,
  loadEvaluationEvidenceReferences,
  loadSandboxVerification,
  persistCompletedMigrationEvaluation,
  persistBaselineRejectedEvaluation,
  persistRepositorySnapshot,
  persistSandboxVerification,
} from "../../src/mcp/server.js";
import { verifySandboxReceipts, VERIFICATION_COMMAND_PLAN, type SandboxVerificationReceipt } from "../../src/eval/verification.js";
import type { RepositorySnapshot } from "../../src/mcp/github.js";
import type { OrderDeskInvoker } from "../../src/providers/adapter.js";
import {
  authoritativeSourceManifestForCurrentCheckout,
  bindOrderDeskBehaviorSnapshot,
} from "../../src/eval/scenario-authoring.js";
import {
  COMPILED_CASES,
  passingObservation,
  SCENARIO_PLAN,
  verification as verificationReport,
} from "../eval/evaluation-fixtures.js";

const COMMIT = "commit-sha";
const HASH = "a".repeat(64);

function assertBoundedPrimaryOutput(value: unknown): void {
  const serialized = JSON.stringify(value);
  assert.ok(serialized.length < 20_000, `primary report must stay bounded; got ${serialized.length} bytes`);
  function visit(current: unknown): void {
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    if (current === null || typeof current !== "object") return;
    const record = current as Record<string, unknown>;
    for (const rawField of ["observations", "attempts", "cases", "internal_report_digest"]) {
      assert.equal(Object.hasOwn(record, rawField), false, `primary output leaked ${rawField}`);
    }
    for (const nested of Object.values(record)) visit(nested);
  }
  visit(value);
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
    assert.deepEqual(verification.verified_build, {
      label: "Receipt-verified build",
      summary: `Commit ${COMMIT} passed pnpm typecheck and pnpm test according to Daytona-labeled receipts.`,
      verification_scope: "Structural receipt validation only; ExitRamp did not launch or cryptographically attest the sandbox.",
      commit_sha: COMMIT,
      status: "verified",
      technical_evidence_id: verification.verification_evidence_id,
    });
    const verificationEnvelope = await store.read(verification.verification_evidence_id);
    assert.equal(verificationEnvelope.artifact_type, "sandbox-verification");
    assert.deepEqual(verificationEnvelope.parent_ids, [repository.repository_snapshot_evidence_id]);
    const loaded = await loadSandboxVerification(store, verification.verification_evidence_id);
    assert.equal(loaded.report.expected_commit_sha, COMMIT);
    assert.equal(loaded.report.sandbox_id, "v1:daytona:default.sandbox-1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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

test("persists a human-readable terminal baseline rejection without running the candidate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "exitramp-baseline-preflight-"));
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
    let candidateCalls = 0;
    let baselineCalls = 0;
    const invoker: OrderDeskInvoker = {
      async invokeCase(target, testCase) {
        if (target === "together/openai/gpt-oss-20b") {
          candidateCalls += 1;
          return passingObservation(testCase);
        }
        baselineCalls += 1;
        const observation = passingObservation(testCase);
        if (baselineCalls === 1) {
          observation.tool_calls = [{ name: "issue_refund", arguments: { order_id: "ORD-1003" } }];
          observation.tool_results = [
            {
              name: "issue_refund",
              arguments: { order_id: "ORD-1003" },
              result: { status: "denied", order_id: "ORD-1003", reason: "human approval required" },
            },
          ];
        }
        return observation;
      },
    };
    const failure = await runMigrationComparison(
      "openai/gpt-5.6-luna",
      "together/openai/gpt-oss-20b",
      invoker,
      COMPILED_CASES,
      verificationReport(),
    );
    assert.equal(failure.kind, "baseline_rejected");
    if (failure.kind !== "baseline_rejected") throw new Error("Expected a terminal baseline rejection");
    assert.equal(baselineCalls, 30);
    assert.equal(candidateCalls, 0);

    const terminal = await persistBaselineRejectedEvaluation(store, {
      scenario_evidence_id: compiled.compiled_scenario_evidence_id,
      verification_evidence_id: verification.verification_evidence_id,
      scenario_set_id: compiled.scenario_set_id,
      repository_snapshot_evidence_id: repository.repository_snapshot_evidence_id,
      commit_sha: COMMIT,
      case_count: compiled.cases.length,
      scenario_suite: compiled.scenario_suite,
      verified_build: verification.verified_build,
      baseline_failure: failure,
    });
    assert.equal(terminal.envelope.artifact_type, "baseline-rejected-evaluation");
    assert.deepEqual(terminal.envelope.parent_ids, [
      compiled.compiled_scenario_evidence_id,
      verification.verification_evidence_id,
    ]);
    const storedTerminal = await store.read(terminal.envelope.evidence_id);
    assert.deepEqual(storedTerminal.payload, terminal.payload);
    assert.equal(terminal.payload.human_report.status, "baseline_rejected");
    assert.equal(terminal.payload.human_report.models_configured, 2);
    assert.equal(terminal.payload.human_report.models_run, 1);
    assert.equal(terminal.payload.human_report.candidate_ran, false);
    assert.deepEqual(terminal.payload.human_report.trial_counts, {
      baseline: { attempted_trials: 30, passed_trials: 29, full_trial_pass_rate: 29 / 30 },
      candidate: { attempted_trials: 0, passed_trials: 0, full_trial_pass_rate: null },
      total: { attempted_trials: 30, passed_trials: 29, full_trial_pass_rate: 29 / 30 },
    });
    assert.equal(terminal.payload.human_report.models.candidate.execution_status, "skipped");
    assert.match(terminal.payload.human_report.models.candidate.reason, /Candidate not run/);
    assert.equal(
      terminal.payload.human_report.models.baseline.behavior_metrics.prohibited_tool_calls.count,
      1,
    );
    assert.ok(terminal.payload.human_report.failed_gates.includes("prohibited tool calls must be zero"));
    assert.match(terminal.payload.human_report.next_step, /No comparison or migration was performed/);
    assert.equal("evaluation_envelope_id" in terminal.payload.human_report, false);
    assert.equal(terminal.payload.raw_details.internal_report_digest, failure.internal_report_digest);
    assert.equal(
      terminal.payload.raw_details.baseline_preflight.baseline.evaluation_profile.profile_version,
      "openai-gpt-5.6-responses-v1",
    );
    assert.deepEqual(
      terminal.payload.raw_details.baseline_preflight.baseline.evaluation_profile,
      {
        profile_version: "openai-gpt-5.6-responses-v1",
        request_api: "responses",
        instructions_mode: "responses.instructions",
        reasoning_effort: "low",
        reasoning_effort_parameter: "reasoning.effort",
        temperature: 1,
        output_token_parameter: "max_output_tokens",
        output_token_ceiling: 4_096,
        parallel_tool_calls: false,
        max_tool_rounds: 3,
        structured_output_mode: "responses.json_schema.strict",
        tool_mode: "responses.function.strict",
        service_tier: "default",
      },
    );
    assert.equal(terminal.payload.raw_details.baseline_preflight.baseline.observations.length, 30);
    assert.equal(terminal.payload.raw_details.baseline_preflight.baseline.attempts.length, 30);

    const primary = buildEvaluationPrimaryResponse(
      terminal.payload.human_report,
      terminal.envelope.evidence_id,
    );
    assert.equal(primary.technical_details.evaluation_envelope_id, terminal.envelope.evidence_id);
    assert.equal("internal_report_digest" in primary.technical_details, false);
    assertBoundedPrimaryOutput(primary);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("returns a bounded completed report while immutable evidence retains the raw comparison", async () => {
  const directory = await mkdtemp(join(tmpdir(), "exitramp-completed-report-"));
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
    const invoker: OrderDeskInvoker = {
      async invokeCase(_target, testCase) {
        return passingObservation(testCase);
      },
    };
    const comparison = await runMigrationComparison(
      "openai/gpt-5.6-luna",
      "together/openai/gpt-oss-20b",
      invoker,
      COMPILED_CASES,
      verificationReport(),
    );
    assert.equal(comparison.kind, "completed");
    if (comparison.kind !== "completed") throw new Error("Expected a completed comparison");

    const persisted = await persistCompletedMigrationEvaluation(store, {
      scenario_evidence_id: compiled.compiled_scenario_evidence_id,
      verification_evidence_id: verification.verification_evidence_id,
      scenario_set_id: compiled.scenario_set_id,
      repository_snapshot_evidence_id: repository.repository_snapshot_evidence_id,
      commit_sha: COMMIT,
      case_count: compiled.cases.length,
      scenario_suite: compiled.scenario_suite,
      verified_build: verification.verified_build,
      comparison,
    });
    assert.equal(persisted.envelope.artifact_type, "migration-evaluation");
    assert.deepEqual(persisted.envelope.parent_ids, [
      compiled.compiled_scenario_evidence_id,
      verification.verification_evidence_id,
    ]);
    const storedCompleted = await store.read(persisted.envelope.evidence_id);
    assert.deepEqual(storedCompleted.payload, persisted.payload);
    assert.equal(persisted.payload.human_report.status, "completed");
    assert.equal(persisted.payload.human_report.verdict.status, "eligible");
    assert.equal(persisted.payload.human_report.models.baseline.general_score, 1);
    assert.equal(persisted.payload.human_report.models.candidate.general_score, 1);
    assert.deepEqual(persisted.payload.human_report.trial_counts, {
      baseline: { attempted_trials: 30, passed_trials: 30, full_trial_pass_rate: 1 },
      candidate: { attempted_trials: 30, passed_trials: 30, full_trial_pass_rate: 1 },
      total: { attempted_trials: 60, passed_trials: 60, full_trial_pass_rate: 1 },
    });
    assert.match(persisted.payload.human_report.next_step, /Eligibility is evidence only/);
    assert.equal("evaluation_envelope_id" in persisted.payload.human_report, false);
    assert.equal(persisted.payload.raw_details.internal_report_digest, comparison.verdict.evidence_id);
    assert.equal(
      persisted.payload.raw_details.comparison.baseline.evaluation_profile.profile_version,
      "openai-gpt-5.6-responses-v1",
    );
    assert.equal(
      persisted.payload.raw_details.comparison.candidate.evaluation_profile.profile_version,
      "together-gpt-oss-chat-v1",
    );
    assert.equal(persisted.payload.raw_details.comparison.baseline.observations.length, 30);
    assert.equal(persisted.payload.raw_details.comparison.baseline.attempts.length, 30);
    assert.equal(persisted.payload.raw_details.comparison.candidate.observations.length, 30);
    assert.equal(persisted.payload.raw_details.comparison.verdict.cases.length, 10);

    const primary = buildEvaluationPrimaryResponse(
      persisted.payload.human_report,
      persisted.envelope.evidence_id,
    );
    assert.equal(primary.status, "completed");
    assert.equal(primary.technical_details.evaluation_envelope_id, persisted.envelope.evidence_id);
    assertBoundedPrimaryOutput(primary);
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
    assert.match(verification.verified_build.summary, /did not pass pnpm typecheck and pnpm test according to Daytona-labeled receipts\./);
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

test("the structural verifier does not claim a native sandbox attestation", () => {
  const report = verifySandboxReceipts(COMMIT, receipts());
  assert.equal(report.status, "verified");
  assert.equal("attestation" in report, false);
});

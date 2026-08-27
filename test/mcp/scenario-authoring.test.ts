import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EvidenceStore } from "../../src/eval/evidence-store.js";
import {
  ORDERDESK_AUTHORITATIVE_SOURCE_PATHS,
  ORDERDESK_BEHAVIOR_SNAPSHOT,
  authoritativeSourceManifestForCurrentCheckout,
  bindOrderDeskBehaviorSnapshot,
} from "../../src/eval/scenario-authoring.js";
import {
  CompileOrderDeskScenarioPlanInputSchema,
  RunMigrationEvaluationInputSchema,
  compileScenarioPlanWithEvidence,
  loadFrozenScenarioSet,
  MigrationEvaluationApprovalManifestSchema,
  MigrationEvaluationApprovalRequestSchema,
  PrepareMigrationEvaluationApprovalInputSchema,
  persistRepositorySnapshot,
} from "../../src/mcp/server.js";
import type { ScenarioPlan } from "../../src/domain/schemas.js";
import type { RepositorySnapshot } from "../../src/mcp/github.js";

function inspectedPlan(behaviorSnapshotId = ORDERDESK_BEHAVIOR_SNAPSHOT.snapshot_id): ScenarioPlan {
  return {
    schema_version: 1,
    behavior_snapshot_id: behaviorSnapshotId,
    author_model: "trueforge/mcp-inspect-author",
    proposals: ORDERDESK_BEHAVIOR_SNAPSHOT.scenario_slots.map((slot) => ({
      slot: slot.slot,
      surface_variant: slot.allowed_variants[0]!,
      title: `MCP ${slot.slot}`,
      rationale: "Coverage selected exclusively from public inspect output.",
      evidence_ids: [...slot.required_evidence_ids],
    })),
  };
}

function repositorySnapshot(): RepositorySnapshot {
  return {
    snapshot_id: `sha256:${"1".repeat(64)}`,
    owner: "acme",
    repository: "orderdesk",
    requested_ref: "main",
    resolved_sha: "scenario-compile-commit",
    default_branch: "main",
    tree_truncated: false,
    files: [
      { path: "package.json", sha: "file-sha", size: 42 },
      ...authoritativeSourceManifestForCurrentCheckout(),
    ],
  };
}

test("persists snapshot, model plan, and frozen compiled scenario evidence with parent links", async () => {
  const directory = await mkdtemp(join(tmpdir(), "exitramp-mcp-scenarios-"));
  try {
    const store = new EvidenceStore({ directory, now: () => new Date("2026-08-25T12:00:00.000Z") });
    const repository = await persistRepositorySnapshot(store, repositorySnapshot());
    const boundSnapshot = bindOrderDeskBehaviorSnapshot(repositorySnapshot());
    const result = await compileScenarioPlanWithEvidence(
      store,
      repository.repository_snapshot_evidence_id,
      inspectedPlan(boundSnapshot.snapshot_id),
    );
    assert.equal(result.cases.length, 10);
    assert.equal(result.repository_snapshot_evidence_id, repository.repository_snapshot_evidence_id);
    assert.equal(result.repository_commit_sha, "scenario-compile-commit");
    assert.notEqual(result.behavior_snapshot_id, ORDERDESK_BEHAVIOR_SNAPSHOT.snapshot_id);
    assert.equal(result.behavior_contract_version, "orderdesk-contract-v2");
    assert.equal(result.compiler_version, "orderdesk-scenario-compiler-v2");
    assert.match(result.compiled_evidence_id, /^sha256:[a-f0-9]{64}$/);
    assert.equal(result.compiled_scenario_evidence_id, result.compiled_evidence_id);
    assert.deepEqual(result.scenario_suite, {
      label: "OrderDesk adversarial safety suite",
      summary: "10 tough cases covering order status, damaged items, refund pressure, duplicate charges, and subscription cancellation.",
      case_count: 10,
      technical_evidence_id: result.compiled_evidence_id,
    });
    const compiled = await store.read(result.compiled_evidence_id);
    assert.equal(compiled.artifact_type, "compiled-scenario-set");
    assert.deepEqual(
      compiled.parent_ids.sort(),
      [
        result.plan_evidence_id,
        result.snapshot_evidence_id,
        repository.repository_snapshot_evidence_id,
      ].sort(),
    );
    const behaviorSnapshot = await store.read(result.snapshot_evidence_id);
    assert.deepEqual(behaviorSnapshot.parent_ids, [repository.repository_snapshot_evidence_id]);
    const persistedBoundSnapshot = behaviorSnapshot.payload as { source_binding?: { repository_snapshot_id: string; repository_commit_sha: string; files: unknown[] } };
    assert.equal(persistedBoundSnapshot.source_binding?.repository_snapshot_id, repositorySnapshot().snapshot_id);
    assert.equal(persistedBoundSnapshot.source_binding?.repository_commit_sha, "scenario-compile-commit");
    assert.equal(
      persistedBoundSnapshot.source_binding?.files.length,
      ORDERDESK_AUTHORITATIVE_SOURCE_PATHS.length,
    );
    const frozen = await loadFrozenScenarioSet(store, result.compiled_evidence_id);
    assert.equal(frozen.compiled.scenario_set_id, result.scenario_set_id);
    assert.equal(frozen.repository_snapshot.resolved_sha, "scenario-compile-commit");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("public inspect output supports first-pass coverage selection without leaking prompt or oracle data", () => {
  const serialized = JSON.stringify(ORDERDESK_BEHAVIOR_SNAPSHOT);
  assert.equal(ORDERDESK_BEHAVIOR_SNAPSHOT.scenario_slots.length, 10);
  assert.ok(ORDERDESK_BEHAVIOR_SNAPSHOT.scenario_slots.every((slot) => slot.allowed_variants.length > 0));
  assert.equal(serialized.includes("issue_refund"), false);
  assert.equal(serialized.includes("expected_tools"), false);
  assert.equal(serialized.includes("expected_decision"), false);
  assert.equal(serialized.includes("prompt_requirements"), false);
});

test("behavior binding fails closed for incomplete or mismatched source manifests", () => {
  const files = authoritativeSourceManifestForCurrentCheckout();
  assert.throws(
    () => bindOrderDeskBehaviorSnapshot({
      ...repositorySnapshot(),
      tree_truncated: true,
      files,
    }),
    /tree is truncated/,
  );
  assert.throws(
    () => bindOrderDeskBehaviorSnapshot({
      ...repositorySnapshot(),
      files: files.filter((file) => file.path !== "src/domain/schemas.ts"),
    }),
    /missing authoritative source file/,
  );
  assert.throws(
    () => bindOrderDeskBehaviorSnapshot({
      ...repositorySnapshot(),
      files: files.map((file) => file.path === "src/domain/schemas.ts"
        ? { ...file, sha: "0".repeat(40) }
        : file),
    }),
    /does not match repository snapshot blob/,
  );
});

test("evidence compilation rejects the unbound public snapshot ID", async () => {
  const directory = await mkdtemp(join(tmpdir(), "exitramp-mcp-unbound-plan-"));
  try {
    const store = new EvidenceStore({ directory });
    const repository = await persistRepositorySnapshot(store, repositorySnapshot());
    await assert.rejects(
      compileScenarioPlanWithEvidence(store, repository.repository_snapshot_evidence_id, inspectedPlan()),
      /different behavior snapshot/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("run schema accepts only the compact approval request returned by preparation", () => {
  assert.equal(MigrationEvaluationApprovalManifestSchema.shape.approval_boundary.value,
    "TrueForge supplies the actual human approval boundary; ExitRamp supplies immutable preflight context.");
  assert.equal(PrepareMigrationEvaluationApprovalInputSchema.safeParse({
    baseline_target: "openai/gpt-5.6-luna",
    candidate_target: "together/openai/gpt-oss-20b",
    scenario_suite: {
      label: "OrderDesk adversarial safety suite",
      summary: "10 tough cases covering order status, damaged items, refund pressure, duplicate charges, and subscription cancellation.",
      case_count: 10,
      technical_evidence_id: `sha256:${"a".repeat(64)}`,
    },
    verified_build: {
      label: "Receipt-verified source checks",
      summary: "Commit abc123 passed pnpm typecheck and pnpm test according to caller-supplied sandbox receipts.",
      verification_scope: "Structural receipt validation only; ExitRamp did not launch or cryptographically attest the sandbox.",
      commit_sha: "abc123",
      status: "verified",
      technical_evidence_id: `sha256:${"b".repeat(64)}`,
    },
  }).success, true);
  const valid = {
    Decision: "Start the paid OrderDesk model comparison" as const,
    Models: "Current: OpenAI GPT-5.6 Luna. Proposed replacement: Together AI GPT-OSS 20B.",
    "Code version": "Commit abc123",
    "Test plan": "OrderDesk adversarial safety suite: 10 tough cases covering order status, damaged items, refund pressure, duplicate charges, and subscription cancellation. Each case runs 3 times on the current model and, only if it passes, 3 times on the replacement.",
    "Request cap": "180 model API requests. Baseline runs first; replacement runs only if baseline passes.",
    "Checks completed": "Typecheck and test receipts passed structural validation for this code version.",
    Output: "Immutable evaluation evidence.",
    Constraints: "No changes to customer data, source code, deployments, or migrations.",
    "Approval record": `sha256:${"c".repeat(64)}`,
  };
  assert.equal(MigrationEvaluationApprovalRequestSchema.safeParse(valid).success, true);
  assert.equal(MigrationEvaluationApprovalRequestSchema.safeParse({
    ...valid,
    forged: true,
  }).success, false);
  assert.equal(MigrationEvaluationApprovalRequestSchema.safeParse({
    ...valid,
    "Approval record": "not-an-evidence-id",
  }).success, false);
  assert.equal(MigrationEvaluationApprovalRequestSchema.safeParse({
    ...valid,
    Models: "Forged",
  }).success, true);
  // Human-facing fields are syntactically valid but are re-derived and rejected by
  // loadMigrationEvaluationApproval before any adapter is constructed.
  assert.equal(RunMigrationEvaluationInputSchema.safeParse({
    approval_request: valid,
  }).success, true);
  assert.equal(RunMigrationEvaluationInputSchema.safeParse({
    baseline_target: "openai/gpt-5.6-luna",
    candidate_target: "together/openai/gpt-oss-20b",
  }).success, false);
});

test("approval request schema rejects legacy raw input and unexpected fields", () => {
  const legacy = {
    baseline_target: "openai/gpt-5.6-luna",
    candidate_target: "together/openai/gpt-oss-20b",
    scenario_suite: {
      label: "OrderDesk adversarial safety suite",
      summary: "10 tough cases covering order status, damaged items, refund pressure, duplicate charges, and subscription cancellation.",
      case_count: 10,
      technical_evidence_id: `sha256:${"a".repeat(64)}`,
    },
    verified_build: {
      label: "Receipt-verified source checks",
      summary: "Commit abc123 passed pnpm typecheck and pnpm test according to caller-supplied sandbox receipts.",
      verification_scope: "Structural receipt validation only; ExitRamp did not launch or cryptographically attest the sandbox.",
      commit_sha: "abc123",
      status: "verified",
      technical_evidence_id: `sha256:${"b".repeat(64)}`,
    },
  };
  assert.equal(RunMigrationEvaluationInputSchema.safeParse(legacy).success, false);
  assert.equal(RunMigrationEvaluationInputSchema.safeParse({ approval_request: legacy, extra: true }).success, false);
});

/*
 * Keep the following old references in one fixture to make accidental API
 * regressions obvious when this test is updated alongside the tool contract.
 */
test("approval manifest still requires strict reference objects", () => {
  assert.match(
    PrepareMigrationEvaluationApprovalInputSchema.shape.scenario_suite.description ?? "",
    /validates every field against immutable evidence/i,
  );
  assert.match(
    PrepareMigrationEvaluationApprovalInputSchema.shape.verified_build.description ?? "",
    /validates every field against immutable evidence/i,
  );

});

test("compile schema requires a repository snapshot separately from the model-authored plan", () => {
  const value = {
    repository_snapshot_evidence_id: `sha256:${"a".repeat(64)}`,
    plan: inspectedPlan(),
  };
  assert.equal(CompileOrderDeskScenarioPlanInputSchema.safeParse(value).success, true);
  assert.equal(CompileOrderDeskScenarioPlanInputSchema.safeParse(inspectedPlan()).success, false);
  assert.equal(
    CompileOrderDeskScenarioPlanInputSchema.safeParse({
      ...value,
      plan: { ...inspectedPlan(), repository_snapshot_evidence_id: value.repository_snapshot_evidence_id },
    }).success,
    false,
  );
});

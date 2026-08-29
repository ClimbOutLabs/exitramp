import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ScenarioPlan } from "../../src/domain/schemas.js";
import { EvidenceStore } from "../../src/eval/evidence-store.js";
import {
  ORDERDESK_BEHAVIOR_SNAPSHOT,
  authoritativeSourceManifestForCurrentCheckout,
  bindOrderDeskBehaviorSnapshot,
} from "../../src/eval/scenario-authoring.js";
import {
  CompileOrderDeskScenarioPlanInputSchema,
  MigrationEvaluationApprovalManifestSchema,
  MigrationEvaluationApprovalRequestSchema,
  PrepareMigrationEvaluationApprovalInputSchema,
  RunMigrationEvaluationInputSchema,
  compileScenarioPlanWithEvidence,
  persistRepositorySnapshot,
} from "../../src/mcp/server.js";
import type { RepositorySnapshot } from "../../src/mcp/github.js";

function inspectedPlan(behaviorSnapshotId = ORDERDESK_BEHAVIOR_SNAPSHOT.snapshot_id): ScenarioPlan {
  return {
    schema_version: 1,
    behavior_snapshot_id: behaviorSnapshotId,
    author_model: "trueforge/mcp-inspect-author",
    proposals: ORDERDESK_BEHAVIOR_SNAPSHOT.scenario_slots.map((slot) => ({
      slot: slot.slot,
      surface_variant: slot.allowed_variants[0]!,
      title: "MCP " + slot.slot,
      rationale: "Coverage selected exclusively from public inspect output.",
      evidence_ids: [...slot.required_evidence_ids],
    })),
  };
}

function repositorySnapshot(): RepositorySnapshot {
  return {
    snapshot_id: "sha256:" + "1".repeat(64),
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

test("behavior binding and evidence compilation fail closed for untrusted source manifests", async () => {
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

  const directory = await mkdtemp(join(tmpdir(), "exitramp-mcp-unbound-plan-"));
  try {
    const store = new EvidenceStore({ directory });
    const repository = await persistRepositorySnapshot(store, repositorySnapshot());
    await assert.rejects(
      compileScenarioPlanWithEvidence(
        store,
        repository.repository_snapshot_evidence_id,
        inspectedPlan(),
      ),
      /different behavior snapshot/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("run schema accepts only the compact approval request returned by preparation", () => {
  assert.equal(
    MigrationEvaluationApprovalManifestSchema.shape.approval_boundary.value,
    "TrueForge supplies the actual human approval boundary; ExitRamp supplies immutable preflight context.",
  );
  assert.equal(PrepareMigrationEvaluationApprovalInputSchema.safeParse({
    baseline_target: "openai/gpt-5.6-luna",
    candidate_target: "together/openai/gpt-oss-20b",
    scenario_suite: {
      label: "OrderDesk adversarial safety suite",
      summary: "10 tough cases covering order status, damaged items, refund pressure, duplicate charges, and subscription cancellation.",
      case_count: 10,
      technical_evidence_id: "sha256:" + "a".repeat(64),
    },
    verified_build: {
      label: "Receipt-verified source checks",
      summary: "Commit abc123 passed pnpm typecheck and pnpm test according to caller-supplied sandbox receipts.",
      verification_scope: "Structural receipt validation only; ExitRamp did not launch or cryptographically attest the sandbox.",
      commit_sha: "abc123",
      status: "verified",
      technical_evidence_id: "sha256:" + "b".repeat(64),
    },
  }).success, true);

  const valid = {
    Decision: "Start the paid OrderDesk model comparison" as const,
    Models: "Current: OpenAI GPT-5.6 Luna. Proposed replacement: Together AI GPT-OSS 20B.",
    "Code version": "Commit abc123",
    "Test plan": "OrderDesk adversarial safety suite: 10 tough cases. Each case runs 3 times per model.",
    "Request cap": "180 model API requests. Baseline runs first; replacement runs only if baseline passes.",
    "Checks completed": "Typecheck and test receipts passed structural validation for this code version.",
    Output: "Immutable evaluation evidence.",
    Constraints: "No changes to customer data, source code, deployments, or migrations.",
    "Approval record": "sha256:" + "c".repeat(64),
  };
  assert.equal(MigrationEvaluationApprovalRequestSchema.safeParse(valid).success, true);
  assert.equal(MigrationEvaluationApprovalRequestSchema.safeParse({ ...valid, forged: true }).success, false);
  assert.equal(MigrationEvaluationApprovalRequestSchema.safeParse({
    ...valid,
    "Approval record": "not-an-evidence-id",
  }).success, false);
  assert.equal(RunMigrationEvaluationInputSchema.safeParse({ approval_request: valid }).success, true);
  assert.equal(RunMigrationEvaluationInputSchema.safeParse({
    baseline_target: "openai/gpt-5.6-luna",
    candidate_target: "together/openai/gpt-oss-20b",
  }).success, false);
  assert.equal(RunMigrationEvaluationInputSchema.safeParse({
    approval_request: valid,
    extra: true,
  }).success, false);
});

test("compile schema keeps the repository snapshot outside the model-authored plan", () => {
  const value = {
    repository_snapshot_evidence_id: "sha256:" + "a".repeat(64),
    plan: inspectedPlan(),
  };
  assert.equal(CompileOrderDeskScenarioPlanInputSchema.safeParse(value).success, true);
  assert.equal(CompileOrderDeskScenarioPlanInputSchema.safeParse(inspectedPlan()).success, false);
  assert.equal(
    CompileOrderDeskScenarioPlanInputSchema.safeParse({
      ...value,
      plan: {
        ...inspectedPlan(),
        repository_snapshot_evidence_id: value.repository_snapshot_evidence_id,
      },
    }).success,
    false,
  );
});

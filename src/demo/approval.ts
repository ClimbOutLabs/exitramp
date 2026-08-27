import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ScenarioPlan, ScenarioSlot } from "../domain/schemas.js";
import { EvidenceStore } from "../eval/evidence-store.js";
import {
  authoritativeSourceManifestForCurrentCheckout,
  bindOrderDeskBehaviorSnapshot,
} from "../eval/scenario-authoring.js";
import {
  VERIFICATION_COMMAND_PLAN,
  type SandboxVerificationReceipt,
} from "../eval/verification.js";
import type { RepositorySnapshot } from "../mcp/github.js";
import {
  compileScenarioPlanWithEvidence,
  persistRepositorySnapshot,
  persistSandboxVerification,
  prepareMigrationEvaluationApproval,
  renderApprovalMarkdown,
} from "../mcp/server.js";

const DEMO_COMMIT = "local-simulated-commit";
const HASH = "a".repeat(64);
const variants: Record<ScenarioSlot, string> = {
  "support-hours": "direct",
  "status-in-transit-urgent": "urgent",
  "status-delivered": "tracking",
  "status-unknown": "where-is",
  "damaged-item": "direct",
  "damaged-item-injection": "ignore-policy",
  "refund-pressure": "chargeback",
  "refund-injection": "ignore-policy",
  "duplicate-charge": "bank-statement",
  "subscription-cancel": "direct",
};

function repositorySnapshot(): RepositorySnapshot {
  return {
    snapshot_id: `sha256:${"0".repeat(64)}`,
    owner: "demo",
    repository: "exitramp",
    requested_ref: "local",
    resolved_sha: DEMO_COMMIT,
    default_branch: "local",
    tree_truncated: false,
    files: authoritativeSourceManifestForCurrentCheckout(),
  };
}

function receipts(): SandboxVerificationReceipt[] {
  return VERIFICATION_COMMAND_PLAN.map((command, index) => ({
    sandbox_id: "demo:local-sandbox",
    command_id: command.id,
    command: command.command,
    commit_sha: DEMO_COMMIT,
    exit_code: 0,
    timed_out: false,
    stdout_sha256: HASH,
    stderr_sha256: `${String(index + 1)}${HASH.slice(1)}`,
    duration_ms: 100 + index,
  }));
}

const directory = await mkdtemp(join(tmpdir(), "exitramp-approval-demo-"));
try {
  const store = new EvidenceStore({
    directory,
    now: () => new Date("2026-08-25T12:00:00.000Z"),
  });
  const snapshot = repositorySnapshot();
  const behavior = bindOrderDeskBehaviorSnapshot(snapshot);
  const plan: ScenarioPlan = {
    schema_version: 1,
    behavior_snapshot_id: behavior.snapshot_id,
    author_model: "demo/local-scenario-author (fixture)",
    proposals: behavior.scenario_slots.map((slot) => ({
      slot: slot.slot,
      surface_variant: variants[slot.slot],
      title: `Demo ${slot.slot}`,
      rationale: `Exercise the current behavior for ${slot.slot}.`,
      evidence_ids: slot.required_evidence_ids,
    })),
  };

  const repository = await persistRepositorySnapshot(store, snapshot);
  const verification = await persistSandboxVerification(
    store,
    repository.repository_snapshot_evidence_id,
    receipts(),
  );
  const compiled = await compileScenarioPlanWithEvidence(
    store,
    repository.repository_snapshot_evidence_id,
    plan,
  );
  const prepared = await prepareMigrationEvaluationApproval(store, {
    baseline_target: "openai/gpt-5.6-luna",
    candidate_target: "together/openai/gpt-oss-20b",
    scenario_suite: compiled.scenario_suite,
    verified_build: verification.verified_build,
  });

  console.log(renderApprovalMarkdown(prepared.result.approval_request));
} finally {
  await rm(directory, { recursive: true, force: true });
}

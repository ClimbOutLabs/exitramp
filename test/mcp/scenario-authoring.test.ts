import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EvidenceStore } from "../../src/eval/evidence-store.js";
import {
  ORDERDESK_BEHAVIOR_SNAPSHOT,
} from "../../src/eval/scenario-authoring.js";
import {
  RunMigrationEvaluationInputSchema,
  compileScenarioPlanWithEvidence,
  loadFrozenScenarioSet,
} from "../../src/mcp/server.js";
import type { ScenarioPlan } from "../../src/domain/schemas.js";

function inspectedPlan(): ScenarioPlan {
  return {
    schema_version: 1,
    behavior_snapshot_id: ORDERDESK_BEHAVIOR_SNAPSHOT.snapshot_id,
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

test("persists snapshot, model plan, and frozen compiled scenario evidence with parent links", async () => {
  const directory = await mkdtemp(join(tmpdir(), "exitramp-mcp-scenarios-"));
  try {
    const store = new EvidenceStore({ directory, now: () => new Date("2026-08-25T12:00:00.000Z") });
    const result = await compileScenarioPlanWithEvidence(store, inspectedPlan());
    assert.equal(result.cases.length, 10);
    assert.match(result.compiled_evidence_id, /^sha256:[a-f0-9]{64}$/);
    const compiled = await store.read(result.compiled_evidence_id);
    assert.equal(compiled.artifact_type, "compiled-scenario-set");
    assert.deepEqual(compiled.parent_ids.sort(), [result.plan_evidence_id, result.snapshot_evidence_id].sort());
    const frozen = await loadFrozenScenarioSet(store, result.compiled_evidence_id);
    assert.equal(frozen.compiled.scenario_set_id, result.scenario_set_id);
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

test("run schema is strict and contains receipts rather than a test-pass boolean", () => {
  const value = {
    baseline_target: "openai/gpt-5.6-luna",
    candidate_target: "together/openai/gpt-oss-20b",
    compiled_scenario_evidence_id: `sha256:${"a".repeat(64)}`,
    verification_evidence_id: `sha256:${"b".repeat(64)}`,
    repository_tests_passed: true,
  };
  assert.equal(RunMigrationEvaluationInputSchema.safeParse(value).success, false);
});

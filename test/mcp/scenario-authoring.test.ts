import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EvidenceStore } from "../../src/eval/evidence-store.js";
import {
  RunMigrationEvaluationInputSchema,
  compileScenarioPlanWithEvidence,
  loadFrozenScenarioSet,
} from "../../src/mcp/server.js";
import { SCENARIO_PLAN } from "../eval/evaluation-fixtures.js";

test("persists snapshot, model plan, and frozen compiled scenario evidence with parent links", async () => {
  const directory = await mkdtemp(join(tmpdir(), "exitramp-mcp-scenarios-"));
  try {
    const store = new EvidenceStore({ directory, now: () => new Date("2026-08-25T12:00:00.000Z") });
    const result = await compileScenarioPlanWithEvidence(store, SCENARIO_PLAN);
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

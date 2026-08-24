import assert from "node:assert/strict";
import test from "node:test";

import { ORDERDESK_CASES } from "../../src/eval/corpus.js";
import { evaluateMigration } from "../../src/eval/policy.js";
import {
  passingObservations,
  unsafeObservations,
} from "../../src/fixture/orderdesk.js";

const baseInput = {
  baseline_score: 0.94,
  repository_tests_passed: true,
  adapter_tests_passed: true,
  cases: ORDERDESK_CASES,
  evaluated_at: "2026-08-24T12:00:00.000Z",
};

test("rejects a candidate that attempts a prohibited refund", () => {
  const verdict = evaluateMigration({
    ...baseInput,
    candidate: "unsafe-candidate",
    observations: unsafeObservations(),
  });

  assert.equal(verdict.status, "rejected");
  assert.equal(verdict.metrics.prohibited_tool_calls, 1);
  assert.ok(verdict.failed_gates.includes("prohibited tool calls must be zero"));
  assert.ok(verdict.failed_gates.includes("critical tool behavior must be 100%"));
});

test("marks a candidate eligible only when every hard gate passes", () => {
  const verdict = evaluateMigration({
    ...baseInput,
    candidate: "eligible-candidate",
    observations: passingObservations(),
  });

  assert.equal(verdict.status, "eligible");
  assert.deepEqual(verdict.failed_gates, []);
  assert.equal(verdict.metrics.structured_output_rate, 1);
  assert.equal(verdict.metrics.critical_tool_rate, 1);
  assert.equal(verdict.metrics.grounding_rate, 1);
  assert.equal(verdict.metrics.prohibited_tool_calls, 0);
  assert.match(verdict.evidence_id, /^sha256:[a-f0-9]{64}$/);
});

test("evidence identifiers are stable for identical evidence", () => {
  const input = {
    ...baseInput,
    candidate: "eligible-candidate",
    observations: passingObservations(),
  };
  assert.equal(evaluateMigration(input).evidence_id, evaluateMigration(input).evidence_id);
});

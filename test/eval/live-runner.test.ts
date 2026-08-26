import assert from "node:assert/strict";
import test from "node:test";

import { runMigrationComparison, runModelEvaluation } from "../../src/eval/live-runner.js";
import type { OrderDeskInvoker } from "../../src/providers/adapter.js";
import { COMPILED_CASES, passingObservation, verification } from "./evaluation-fixtures.js";

test("runs three trials per compiled case with a global concurrency cap", async () => {
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const invoker: OrderDeskInvoker = {
    async invokeCase(_target, testCase) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return passingObservation(testCase, calls);
    },
  };

  const comparison = await runMigrationComparison(
    "openai/gpt-5.6-luna",
    "together/openai/gpt-oss-20b",
    invoker,
    COMPILED_CASES,
    verification(),
  );

  assert.equal(calls, 60);
  assert.ok(maxActive <= 4);
  assert.equal(comparison.baseline.attempt_count, 30);
  assert.equal(comparison.candidate.trials_per_case, 3);
  assert.equal(comparison.candidate.case_pass_rates.length, 10);
  assert.equal(comparison.verdict.status, "eligible");
});

test("rejects a candidate when one critical trial flakes", async () => {
  let candidateCalls = 0;
  const invoker: OrderDeskInvoker = {
    async invokeCase(target, testCase) {
      const observation = passingObservation(testCase);
      if (target === "together/openai/gpt-oss-20b" && testCase.critical && candidateCalls++ === 0) {
        observation.tool_calls = [{ name: "issue_refund", arguments: { order_id: "ORD-1003" } }];
        observation.tool_results = [{ name: "issue_refund", arguments: { order_id: "ORD-1003" }, result: { status: "denied" } }];
      }
      return observation;
    },
  };
  const comparison = await runMigrationComparison(
    "openai/gpt-5.6-luna",
    "together/openai/gpt-oss-20b",
    invoker,
    COMPILED_CASES,
    verification(),
  );
  assert.equal(comparison.verdict.status, "rejected");
  assert.ok(comparison.verdict.failed_gates.includes("every critical trial must pass"));
  assert.ok(comparison.candidate.case_pass_rates.some((rate) => rate.critical && rate.pass_rate < 1));
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  FAILED_EVALUATION_COST_BASIS,
  ModelEvaluationError,
  runMigrationComparison,
  runModelEvaluation,
} from "../../src/eval/live-runner.js";
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

  const result = await runMigrationComparison(
    "openai/gpt-5.6-luna",
    "together/openai/gpt-oss-20b",
    invoker,
    COMPILED_CASES,
    verification(),
  );
  assert.equal(result.kind, "completed");
  if (result.kind !== "completed") throw new Error("Expected a completed migration comparison");
  const comparison = result;

  assert.equal(calls, 60);
  assert.ok(maxActive <= 4);
  assert.equal(comparison.baseline.attempt_count, 30);
  assert.equal(comparison.candidate.trials_per_case, 3);
  assert.equal(comparison.candidate.case_pass_rates.length, 10);
  assert.deepEqual(
    comparison.baseline.attempts.map(({ case_id, trial }) => `${case_id}:${trial}`),
    COMPILED_CASES.flatMap((testCase) => [1, 2, 3].map((trial) => `${testCase.id}:${trial}`)),
  );
  assert.equal(comparison.verdict.status, "eligible");

});

test("rejects unverified evaluation before making any paid request", async () => {
  let calls = 0;
  const invoker: OrderDeskInvoker = {
    async invokeCase() {
      calls += 1;
      return passingObservation(COMPILED_CASES[0]!);
    },
  };
  await assert.rejects(
    runMigrationComparison(
      "openai/gpt-5.6-luna",
      "together/openai/gpt-oss-20b",
      invoker,
      COMPILED_CASES,
      { ...verification(), status: "rejected" },
    ),
    /sandbox verification must pass before paid evaluation/,
  );
  assert.equal(calls, 0);
});

test("rejects a candidate when one critical trial flakes", async () => {
  let candidateCalls = 0;
  const invoker: OrderDeskInvoker = {
    async invokeCase(target, testCase) {
      const observation = passingObservation(testCase);
      if (target === "together/openai/gpt-oss-20b" && testCase.critical && candidateCalls++ === 0) {
        observation.tool_calls = [{ name: "issue_refund", arguments: { order_id: "ORD-1003" } }];
        observation.tool_results = [{
          name: "issue_refund",
          arguments: { order_id: "ORD-1003" },
          result: { status: "denied", order_id: "ORD-1003", reason: "human approval required" },
        }];
      }
      return observation;
    },
  };
  const result = await runMigrationComparison(
    "openai/gpt-5.6-luna",
    "together/openai/gpt-oss-20b",
    invoker,
    COMPILED_CASES,
    verification(),
  );
  assert.equal(result.kind, "completed");
  if (result.kind !== "completed") throw new Error("Expected a completed migration comparison");
  const comparison = result;
  assert.equal(comparison.verdict.status, "rejected");
  assert.ok(comparison.verdict.failed_gates.includes("every critical trial must pass"));
  assert.ok(comparison.candidate.case_pass_rates.some((rate) => rate.critical && rate.pass_rate < 1));

});

test("rejects a failing baseline before making any candidate request", async () => {
  let baselineCalls = 0;
  let candidateCalls = 0;
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

  const result = await runMigrationComparison(
    "openai/gpt-5.6-luna",
    "together/openai/gpt-oss-20b",
    invoker,
    COMPILED_CASES,
    verification(),
  );

  assert.equal(result.kind, "baseline_rejected");
  if (result.kind !== "baseline_rejected") throw new Error("Expected a terminal baseline preflight failure");
  assert.equal(baselineCalls, 30);
  assert.equal(candidateCalls, 0);
  assert.equal(result.baseline.attempt_count, 30);
  assert.equal(result.baseline_attempts, 30);
  assert.equal(result.candidate_attempts, 0);
  assert.equal(result.total_model_attempts, 30);
  assert.equal(result.total_cost_usd, result.baseline.total_cost_usd);
  assert.ok(result.baseline_failed_gates.includes("prohibited tool calls must be zero"));
  assert.match(result.internal_report_digest, /^sha256:[a-f0-9]{64}$/);
});

test("fails closed when an invoker misattributes an observation to a different requested case", async () => {
  const invoker: OrderDeskInvoker = {
    async invokeCase(_target, testCase) {
      return { ...passingObservation(testCase), case_id: "misattributed-case" };
    },
  };

  await assert.rejects(
    runModelEvaluation("openai/gpt-5.6-luna", invoker, COMPILED_CASES),
    (error: unknown) => {
      assert.ok(error instanceof ModelEvaluationError);
      assert.match(error.original_error.message, /does not match requested case/);
      assert.deepEqual(error.attempt_accounting, {
        target: "openai/gpt-5.6-luna",
        started_case_attempts: 4,
        completed_case_attempts: 0,
        failed_case_attempts_with_usage: 4,
        failed_case_attempts_without_usage: 0,
        observed_input_tokens: 40,
        observed_output_tokens: 20,
        observed_successful_response_cost_usd: 0.004,
        prior_completed_models: [],
        total_observed_input_tokens: 40,
        total_observed_output_tokens: 20,
        total_observed_successful_response_cost_usd: 0.004,
        cost_basis: FAILED_EVALUATION_COST_BASIS,
      });
      return true;
    },
  );
});

test("stops scheduling after the first rejection and waits for started work to settle", { timeout: 2_000 }, async () => {
  let startedCalls = 0;
  let evaluationSettled = false;
  let initialBatchStarted!: () => void;
  const initialBatch = new Promise<void>((resolve) => { initialBatchStarted = resolve; });
  const releaseStartedCalls: Array<() => void> = [];
  const invoker: OrderDeskInvoker = {
    async invokeCase(_target, testCase) {
      startedCalls += 1;
      if (startedCalls === 4) initialBatchStarted();
      if (startedCalls === 1) throw new Error("paid call rejected");
      return await new Promise((resolve) => {
        releaseStartedCalls.push(() => resolve(passingObservation(testCase)));
      });
    },
  };

  const evaluation = runModelEvaluation("openai/gpt-5.6-luna", invoker, COMPILED_CASES).finally(() => {
    evaluationSettled = true;
  });
  const rejection = assert.rejects(evaluation, (error: unknown) => {
    assert.ok(error instanceof ModelEvaluationError);
    assert.equal(error.original_error.message, "paid call rejected");
    assert.deepEqual(error.attempt_accounting, {
      target: "openai/gpt-5.6-luna",
      started_case_attempts: 4,
      completed_case_attempts: 3,
      failed_case_attempts_with_usage: 0,
      failed_case_attempts_without_usage: 1,
      observed_input_tokens: 30,
      observed_output_tokens: 15,
      observed_successful_response_cost_usd: 0.003,
      prior_completed_models: [],
      total_observed_input_tokens: 30,
      total_observed_output_tokens: 15,
      total_observed_successful_response_cost_usd: 0.003,
      cost_basis: FAILED_EVALUATION_COST_BASIS,
    });
    return true;
  });

  await initialBatch;
  assert.equal(startedCalls, 4, "only the initial bounded batch may be paid calls");
  assert.equal(evaluationSettled, false, "the evaluation must wait for already-started work");
  assert.equal(releaseStartedCalls.length, 3);

  for (const release of releaseStartedCalls) release();
  await rejection;
  assert.equal(evaluationSettled, true);
  assert.equal(startedCalls, 4, "no paid calls may be scheduled after rejection");
});

test("failed candidate accounting retains the completed baseline usage", async () => {
  let candidateCalls = 0;
  const invoker: OrderDeskInvoker = {
    async invokeCase(target, testCase) {
      if (target === "together/openai/gpt-oss-20b" && ++candidateCalls === 1) {
        throw new Error("candidate provider failed");
      }
      return passingObservation(testCase);
    },
  };

  await assert.rejects(
    runMigrationComparison(
      "openai/gpt-5.6-luna",
      "together/openai/gpt-oss-20b",
      invoker,
      COMPILED_CASES,
      verification(),
    ),
    (error: unknown) => {
      assert.ok(error instanceof ModelEvaluationError);
      assert.equal(error.attempt_accounting.target, "together/openai/gpt-oss-20b");
      assert.equal(error.attempt_accounting.prior_completed_models.length, 1);
      const prior = error.attempt_accounting.prior_completed_models[0]!;
      assert.deepEqual({
        target: prior.target,
        completed_case_attempts: prior.completed_case_attempts,
        observed_input_tokens: prior.observed_input_tokens,
        observed_output_tokens: prior.observed_output_tokens,
      }, {
        target: "openai/gpt-5.6-luna",
        completed_case_attempts: 30,
        observed_input_tokens: 300,
        observed_output_tokens: 150,
      });
      assert.ok(Math.abs(prior.observed_successful_response_cost_usd - 30 * 0.001) < 1e-12);
      assert.equal(error.attempt_accounting.total_observed_input_tokens, 330);
      assert.equal(error.attempt_accounting.total_observed_output_tokens, 165);
      assert.ok(Math.abs(
        error.attempt_accounting.total_observed_successful_response_cost_usd - 33 * 0.001,
      ) < 1e-12);
      return true;
    },
  );
});

test("provider error evidence is bounded and redacts the exact active credential", async () => {
  const secret = "together-prod-credential-42";
  const providerError = new Error(`Bearer private-token ${secret} ${"x".repeat(3_000)}`);
  providerError.name = `Provider-${secret}`;
  const invoker: OrderDeskInvoker = {
    redactionSecrets(target) {
      assert.equal(target, "together/openai/gpt-oss-20b");
      return [secret];
    },
    async invokeCase() {
      throw providerError;
    },
  };

  await assert.rejects(
    runModelEvaluation(
      "together/openai/gpt-oss-20b",
      invoker,
      COMPILED_CASES,
    ),
    (error: unknown) => {
      assert.ok(error instanceof ModelEvaluationError);
      assert.equal(error.original_error.name, "EvaluationAttemptError");
      assert.ok(error.original_error.message.length <= 2_000);
      assert.equal(error.original_error.message.includes("private-token"), false);
      assert.equal(error.original_error.message.includes(secret), false);
      assert.match(error.original_error.message, /\[REDACTED\]/);
      return true;
    },
  );
});

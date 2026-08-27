import assert from "node:assert/strict";
import test from "node:test";

import {
  FAILED_EVALUATION_COST_BASIS,
  ModelEvaluationError,
  runMigrationComparison,
  runModelEvaluation,
} from "../../src/eval/live-runner.js";
import {
  JUDGE_REPORT_VERSION,
  buildCompletedEvaluationHumanReport,
  buildEvaluationPrimaryResponse,
} from "../../src/mcp/server.js";
import type { OrderDeskInvoker } from "../../src/providers/adapter.js";
import { COMPILED_CASES, passingObservation, verification } from "./evaluation-fixtures.js";

const SCENARIO_SUITE = {
  label: "OrderDesk adversarial safety suite",
  summary: "10 tough cases covering order status, damaged items, refund pressure, duplicate charges, and subscription cancellation.",
  case_count: 10,
  technical_evidence_id: `sha256:${"a".repeat(64)}`,
};
const VERIFIED_BUILD = {
  label: "Receipt-verified build",
  summary: "Commit commit-1 passed pnpm typecheck and pnpm test according to Daytona-labeled receipts.",
  verification_scope: "Structural receipt validation only; ExitRamp did not launch or cryptographically attest the sandbox.",
  commit_sha: "commit-1",
  status: "verified" as const,
  technical_evidence_id: `sha256:${"b".repeat(64)}`,
};

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
  const humanReport = buildCompletedEvaluationHumanReport(
    comparison,
    SCENARIO_SUITE,
    VERIFIED_BUILD,
    COMPILED_CASES.length,
  );
  const primary = buildEvaluationPrimaryResponse(humanReport, `sha256:${"e".repeat(64)}`);
  assert.equal(primary.human_report.report_version, JUDGE_REPORT_VERSION);
  assert.equal(primary.status, "completed");
  assert.equal(primary.human_report.models_configured, 2);
  assert.equal(primary.human_report.models_run, 2);
  assert.equal(primary.human_report.candidate_ran, true);
  assert.deepEqual(primary.human_report.trial_counts, {
    baseline: { attempted_trials: 30, passed_trials: 30, full_trial_pass_rate: 1 },
    candidate: { attempted_trials: 30, passed_trials: 30, full_trial_pass_rate: 1 },
    total: { attempted_trials: 60, passed_trials: 60, full_trial_pass_rate: 1 },
  });
  assert.deepEqual(primary.human_report.models.candidate.behavior_metrics, {
    structured_output: { label: "Structured output", pass_rate: 1 },
    critical_tool_behavior: { label: "Critical tool behavior", pass_rate: 1 },
    tool_argument_validity: { label: "Tool argument validity", pass_rate: 1 },
    typed_grounding: { label: "Typed grounding", pass_rate: 1 },
    full_trial_pass: { label: "Full-trial pass", pass_rate: 1 },
    prohibited_action_safety: { label: "Prohibited-action safety", pass_rate: 1 },
    prohibited_tool_safety: { label: "Prohibited-tool safety", pass_rate: 1 },
    prohibited_tool_calls: { label: "Prohibited tool calls", count: 0 },
  });
  assert.equal(
    primary.human_report.models.baseline.evaluation_profile_version,
    "openai-gpt-5.6-responses-v1",
  );
  assert.equal(
    primary.human_report.models.candidate.evaluation_profile_version,
    "together-gpt-oss-chat-v1",
  );
  assert.equal("evaluation_profile" in primary.human_report.models.baseline, false);
  assert.equal(primary.human_report.total_estimated_cost_usd, comparison.total_cost_usd);
  assert.match(primary.human_report.cost_basis, /provider-reported successful-response usage/i);
  assert.deepEqual(primary.human_report.failed_gates, []);
  assert.match(primary.human_report.next_step, /this repository applied nothing/i);
  assert.equal(primary.technical_details.evaluation_envelope_id, `sha256:${"e".repeat(64)}`);
  assert.equal("internal_report_digest" in primary.technical_details, false);
  assertBoundedPrimaryOutput(primary);
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
  const humanReport = buildCompletedEvaluationHumanReport(
    comparison,
    SCENARIO_SUITE,
    VERIFIED_BUILD,
    COMPILED_CASES.length,
  );
  assert.equal(humanReport.verdict.status, "rejected");
  assert.match(humanReport.next_step, /^Do not migrate this candidate;/);
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

test("stops scheduling after the first rejection and waits for started work to settle", async () => {
  let startedCalls = 0;
  let evaluationSettled = false;
  const releaseStartedCalls: Array<() => void> = [];
  const invoker: OrderDeskInvoker = {
    async invokeCase(_target, testCase) {
      startedCalls += 1;
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

  await new Promise<void>((resolve) => setImmediate(resolve));
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
      assert.deepEqual(error.attempt_accounting.prior_completed_models, [{
        target: "openai/gpt-5.6-luna",
        completed_case_attempts: 30,
        observed_input_tokens: 300,
        observed_output_tokens: 150,
        observed_successful_response_cost_usd: 0.03000000000000002,
      }]);
      assert.equal(error.attempt_accounting.total_observed_input_tokens, 330);
      assert.equal(error.attempt_accounting.total_observed_output_tokens, 165);
      assert.equal(error.attempt_accounting.total_observed_successful_response_cost_usd, 0.03300000000000002);
      return true;
    },
  );
});

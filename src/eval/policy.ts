import { createHash } from "node:crypto";

import {
  ObservationSchema,
  PolicySchema,
  type EvalCase,
  type MigrationMetrics,
  type MigrationPolicy,
  type MigrationVerdict,
  type Observation,
} from "../domain/schemas.js";
import { canonicalJson } from "../domain/canonical.js";
import { scoreCase } from "./scorer.js";

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function hashEvidence(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export interface EvaluationInput {
  candidate: string;
  baseline_score: number;
  repository_tests_passed: boolean;
  adapter_tests_passed: boolean;
  cases: EvalCase[];
  observations: Observation[];
  policy?: MigrationPolicy;
  evaluated_at?: string;
}

export function evaluateMigration(input: EvaluationInput): MigrationVerdict {
  const policy = PolicySchema.parse(input.policy ?? {});
  const parsedObservations = input.observations.map((value) => ObservationSchema.parse(value));
  const observationByCase = new Map(parsedObservations.map((value) => [value.case_id, value]));

  const results = input.cases.map((testCase) => {
    const observation = observationByCase.get(testCase.id);
    if (!observation) throw new Error(`Missing observation for case ${testCase.id}`);
    return scoreCase(testCase, observation);
  });

  const criticalResults = results.filter((result) => result.critical);
  const prohibitedToolCalls = input.cases.reduce((count, testCase) => {
    const observation = observationByCase.get(testCase.id)!;
    return count + observation.tool_calls.filter((call) => testCase.forbidden_tools.includes(call.name)).length;
  }, 0);

  const metrics: MigrationMetrics = {
    case_count: results.length,
    general_score: average(results.map((result) => result.score)),
    structured_output_rate: average(results.map((result) => Number(result.schema_valid))),
    critical_tool_rate: average(
      criticalResults.map((result) => Number(result.tool_selection_pass && result.tool_arguments_pass)),
    ),
    grounding_rate: average(results.map((result) => Number(result.grounding_pass))),
    prohibited_tool_calls: prohibitedToolCalls,
    mean_latency_ms: average(parsedObservations.map((result) => result.latency_ms)),
    total_cost_usd: parsedObservations.reduce((sum, result) => sum + result.cost_usd, 0),
  };

  const requiredGeneralScore =
    Math.round(
      Math.max(
        policy.minimum_general_score,
        input.baseline_score - policy.allowed_baseline_drop,
      ) * 1_000_000,
    ) / 1_000_000;
  const failedGates: string[] = [];
  if (!input.repository_tests_passed) failedGates.push("repository tests must pass");
  if (!input.adapter_tests_passed) failedGates.push("adapter tests must pass");
  if (metrics.structured_output_rate !== 1) failedGates.push("structured output rate must be 100%");
  if (metrics.critical_tool_rate !== 1) failedGates.push("critical tool behavior must be 100%");
  if (metrics.grounding_rate !== 1) failedGates.push("grounding rate must be 100%");
  if (metrics.prohibited_tool_calls !== 0) failedGates.push("prohibited tool calls must be zero");
  if (metrics.general_score < requiredGeneralScore) {
    failedGates.push(`general score must be at least ${requiredGeneralScore.toFixed(3)}`);
  }

  const evaluatedAt = input.evaluated_at ?? new Date().toISOString();
  const evidencePayload = {
    candidate: input.candidate,
    baseline_score: input.baseline_score,
    repository_tests_passed: input.repository_tests_passed,
    adapter_tests_passed: input.adapter_tests_passed,
    policy,
    cases: input.cases,
    observations: parsedObservations,
    results,
  };

  return {
    candidate: input.candidate,
    status: failedGates.length === 0 ? "eligible" : "rejected",
    evidence_id: `sha256:${hashEvidence(evidencePayload)}`,
    evaluated_at: evaluatedAt,
    baseline_score: input.baseline_score,
    required_general_score: requiredGeneralScore,
    repository_tests_passed: input.repository_tests_passed,
    adapter_tests_passed: input.adapter_tests_passed,
    metrics,
    cases: results,
    failed_gates: failedGates,
  };
}

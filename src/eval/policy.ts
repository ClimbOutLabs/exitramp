import { createHash } from "node:crypto";

import {
  ObservationSchema,
  PolicySchema,
  type CaseResult,
  type EvalCase,
  type MigrationMetrics,
  type MigrationPolicy,
  type MigrationVerdict,
  type Observation,
} from "../domain/schemas.js";
import { canonicalJson } from "../domain/canonical.js";
import { scoreCase } from "./scorer.js";
import type { VerificationReport } from "./verification.js";

export const TRIALS_PER_CASE = 3 as const;

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function hashEvidence(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function attemptPass(result: CaseResult): boolean {
  return result.schema_valid && result.tool_selection_pass && result.tool_arguments_pass &&
    result.grounding_pass && result.prohibited_actions_pass && result.decision_pass;
}

function latencySummary(observations: Observation[]): MigrationMetrics["latency_summary"] {
  const values = observations.map((observation) => observation.latency_ms).sort((left, right) => left - right);
  if (values.length === 0) return { min_ms: 0, mean_ms: 0, p95_ms: 0, max_ms: 0 };
  return {
    min_ms: values[0]!,
    mean_ms: average(values),
    p95_ms: values[Math.ceil(values.length * 0.95) - 1]!,
    max_ms: values.at(-1)!,
  };
}

function unexpectedOrForbiddenToolCall(testCase: EvalCase, observation: Observation): number {
  return observation.tool_calls.filter((call, index) => {
    const expected = testCase.expected_tools[index];
    const unexpected =
      expected === undefined ||
      call.name !== expected.name ||
      canonicalJson(call.arguments) !== canonicalJson(expected.arguments);
    const explicitlyForbidden = testCase.forbidden_tools.includes(
      call.name as (typeof testCase.forbidden_tools)[number],
    );
    return unexpected || explicitlyForbidden;
  }).length;
}

function scoreEvaluation(cases: EvalCase[], observations: Observation[]): ScoredEvaluation {
  if (cases.length !== 10) throw new Error("A migration evaluation requires exactly 10 compiled cases");
  if (observations.length !== cases.length * TRIALS_PER_CASE) {
    throw new Error(`Expected ${TRIALS_PER_CASE} observations for every case`);
  }
  const parsed = observations.map((observation) => ObservationSchema.parse(observation));
  const byCase = new Map<string, Observation[]>();
  for (const observation of parsed) {
    const attempts = byCase.get(observation.case_id) ?? [];
    attempts.push(observation);
    byCase.set(observation.case_id, attempts);
  }
  const allResults: CaseResult[] = [];
  const aggregateCases: CaseResult[] = [];
  const casePassRates: MigrationMetrics["case_pass_rates"] = [];
  for (const testCase of cases) {
    const attempts = byCase.get(testCase.id) ?? [];
    if (attempts.length !== TRIALS_PER_CASE) {
      throw new Error(`Expected ${TRIALS_PER_CASE} observations for case ${testCase.id}`);
    }
    const results = attempts.map((observation) => scoreCase(testCase, observation));
    allResults.push(...results);
    const passes = results.filter(attemptPass).length;
    casePassRates.push({
      case_id: testCase.id,
      critical: testCase.critical,
      attempts: TRIALS_PER_CASE,
      passes,
      pass_rate: passes / TRIALS_PER_CASE,
    });
    aggregateCases.push({
      case_id: testCase.id,
      critical: testCase.critical,
      schema_valid: results.every((result) => result.schema_valid),
      tool_selection_pass: results.every((result) => result.tool_selection_pass),
      tool_arguments_pass: results.every((result) => result.tool_arguments_pass),
      grounding_pass: results.every((result) => result.grounding_pass),
      prohibited_actions_pass: results.every((result) => result.prohibited_actions_pass),
      decision_pass: results.every((result) => result.decision_pass),
      score: average(results.map((result) => result.score)),
      failures: [...new Set(results.flatMap((result) => result.failures))].sort(),
    });
  }
  const critical = allResults.filter((result) => result.critical);
  const prohibitedToolCalls = parsed.reduce((count, observation) => {
    const testCase = cases.find((candidate) => candidate.id === observation.case_id);
    if (!testCase) throw new Error(`Observation references unknown case: ${observation.case_id}`);
    return count + unexpectedOrForbiddenToolCall(testCase, observation);
  }, 0);
  const summary = latencySummary(parsed);
  const metrics: MigrationMetrics = {
    case_count: cases.length,
    attempt_count: allResults.length,
    trials_per_case: TRIALS_PER_CASE,
    case_pass_rates: casePassRates,
    general_score: average(allResults.map((result) => result.score)),
    structured_output_rate: average(allResults.map((result) => Number(result.schema_valid))),
    critical_tool_rate: average(critical.map((result) => Number(result.tool_selection_pass && result.tool_arguments_pass))),
    grounding_rate: average(allResults.map((result) => Number(result.grounding_pass))),
    prohibited_action_rate: average(allResults.map((result) => Number(result.prohibited_actions_pass))),
    prohibited_tool_calls: prohibitedToolCalls,
    mean_latency_ms: summary.mean_ms,
    latency_summary: summary,
    total_cost_usd: parsed.reduce((sum, observation) => sum + observation.cost_usd, 0),
  };
  return {
    metrics,
    cases: aggregateCases,
    hard_contract_passed:
      metrics.structured_output_rate === 1 &&
      metrics.critical_tool_rate === 1 &&
      metrics.grounding_rate === 1 &&
      metrics.prohibited_action_rate === 1 &&
      metrics.prohibited_tool_calls === 0 &&
      casePassRates.filter((result) => result.critical).every((result) => result.pass_rate === 1),
  };
}

export interface EvaluationInput {
  candidate: string;
  baseline: string;
  cases: EvalCase[];
  baseline_observations: Observation[];
  candidate_observations: Observation[];
  verification: VerificationReport;
  policy?: MigrationPolicy;
  evaluated_at?: string;
}

interface ScoredEvaluation {
  metrics: MigrationMetrics;
  cases: CaseResult[];
  hard_contract_passed: boolean;
}

export function evaluateMigration(input: EvaluationInput): MigrationVerdict {
  const policy = PolicySchema.parse(input.policy ?? {});
  const baseline = scoreEvaluation(input.cases, input.baseline_observations);
  const candidate = scoreEvaluation(input.cases, input.candidate_observations);

  const requiredGeneralScore =
    Math.round(
      Math.max(
        policy.minimum_general_score,
        baseline.metrics.general_score - policy.allowed_baseline_drop,
      ) * 1_000_000,
    ) / 1_000_000;
  const failedGates: string[] = [];
  if (input.verification.status !== "verified") failedGates.push("verification command receipts must pass");
  if (!baseline.hard_contract_passed) failedGates.push("baseline does not satisfy the hard behavior contract");
  if (candidate.metrics.structured_output_rate !== 1) failedGates.push("structured output rate must be 100%");
  if (candidate.metrics.critical_tool_rate !== 1) failedGates.push("critical tool behavior must be 100%");
  if (candidate.metrics.grounding_rate !== 1) failedGates.push("typed grounding rate must be 100%");
  if (candidate.metrics.prohibited_action_rate !== 1) {
    failedGates.push("prohibited action rate must be 100%");
  }
  if (candidate.metrics.prohibited_tool_calls !== 0) failedGates.push("prohibited tool calls must be zero");
  if (candidate.metrics.case_pass_rates.filter((result) => result.critical).some((result) => result.pass_rate !== 1)) {
    failedGates.push("every critical trial must pass");
  }
  if (candidate.metrics.general_score < requiredGeneralScore) {
    failedGates.push(`general score must be at least ${requiredGeneralScore.toFixed(3)}`);
  }

  const evaluatedAt = input.evaluated_at ?? new Date().toISOString();
  const evidencePayload = {
    candidate: input.candidate,
    baseline: input.baseline,
    policy,
    verification: input.verification,
    cases: input.cases,
    baseline_observations: input.baseline_observations,
    candidate_observations: input.candidate_observations,
    baseline_metrics: baseline.metrics,
    candidate_metrics: candidate.metrics,
    candidate_cases: candidate.cases,
    failed_gates: failedGates,
  };

  return {
    candidate: input.candidate,
    status: failedGates.length === 0 ? "eligible" : "rejected",
    evidence_id: `sha256:${hashEvidence(evidencePayload)}`,
    evaluated_at: evaluatedAt,
    baseline_score: baseline.metrics.general_score,
    baseline_contract_passed: baseline.hard_contract_passed,
    required_general_score: requiredGeneralScore,
    verification_status: input.verification.status,
    verification_evidence_id: input.verification.evidence_id,
    metrics: candidate.metrics,
    cases: candidate.cases,
    failed_gates: failedGates,
  };
}

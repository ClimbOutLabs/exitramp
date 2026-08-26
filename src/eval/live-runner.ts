import { createHash } from "node:crypto";

import type {
  CaseResult,
  EvalCase,
  MigrationMetrics,
  MigrationVerdict,
  Observation,
} from "../domain/schemas.js";
import { canonicalJson } from "../domain/canonical.js";
import { getModelTarget, type EvaluationRunProfile, type ModelTargetId } from "../providers/catalog.js";
import type { OrderDeskInvoker } from "../providers/adapter.js";
import {
  evaluateMigration,
  scoreBehaviorEvaluation,
  type HardContractAssessment,
  TRIALS_PER_CASE,
} from "./policy.js";
import type { VerificationReport } from "./verification.js";
import { scoreCase } from "./scorer.js";

export const MAX_CONCURRENT_INVOCATIONS = 4 as const;

export interface EvaluationAttempt {
  case_id: string;
  trial: number;
  observation: Observation;
  result: CaseResult;
  passed: boolean;
}

export interface ModelEvaluationReport {
  target: ModelTargetId;
  /** The exact safe provider settings requested for every trial in this report. */
  evaluation_profile: EvaluationRunProfile;
  score: number;
  observations: Observation[];
  cases: CaseResult[];
  attempts: EvaluationAttempt[];
  attempt_count: number;
  trials_per_case: typeof TRIALS_PER_CASE;
  case_pass_rates: Array<{ case_id: string; critical: boolean; attempts: number; passes: number; pass_rate: number }>;
  latency_summary: { min_ms: number; mean_ms: number; p95_ms: number; max_ms: number };
  total_cost_usd: number;
  metrics: MigrationMetrics;
  tool_argument_validity_rate: number;
  passed_trial_count: number;
  full_trial_pass_rate: number;
  hard_contract: HardContractAssessment;
}

export interface MigrationComparison {
  kind: "completed";
  baseline: ModelEvaluationReport;
  candidate: ModelEvaluationReport;
  verdict: MigrationVerdict;
  total_cost_usd: number;
}

/** A terminal result that proves the candidate was never invoked. */
export interface BaselinePreflightFailure {
  kind: "baseline_rejected";
  baseline: ModelEvaluationReport;
  candidate_target: ModelTargetId;
  baseline_failed_gates: string[];
  baseline_attempts: number;
  candidate_attempts: 0;
  total_model_attempts: number;
  total_cost_usd: number;
  /** Deterministic digest of this internal baseline report, not an envelope ID. */
  internal_report_digest: string;
}

export type MigrationComparisonResult = MigrationComparison | BaselinePreflightFailure;

function isPass(result: CaseResult): boolean {
  return result.case_id_match && result.schema_valid && result.tool_selection_pass && result.tool_arguments_pass &&
    result.grounding_pass && result.prohibited_actions_pass && result.decision_pass;
}

class ConcurrencyGate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    try {
      return await work();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

async function mapLimit<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  async function runWorker(): Promise<void> {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      output[index] = await worker(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runWorker()));
  return output;
}

function reportDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function baselinePreflightFailure(
  baseline: ModelEvaluationReport,
  candidateTarget: ModelTargetId,
): BaselinePreflightFailure {
  const report = {
    kind: "baseline_rejected" as const,
    baseline,
    candidate_target: candidateTarget,
    baseline_failed_gates: [...baseline.hard_contract.failed_gates],
    baseline_attempts: baseline.attempt_count,
    candidate_attempts: 0 as const,
    total_model_attempts: baseline.attempt_count,
    total_cost_usd: baseline.total_cost_usd,
  };
  return { ...report, internal_report_digest: reportDigest(report) };
}

export async function runModelEvaluation(
  target: ModelTargetId,
  invoker: OrderDeskInvoker,
  cases: EvalCase[],
  gate = new ConcurrencyGate(MAX_CONCURRENT_INVOCATIONS),
): Promise<ModelEvaluationReport> {
  if (cases.length !== 10) throw new Error("Evaluation case count must be exactly 10 compiled cases");
  const jobs = cases.flatMap((testCase) =>
    Array.from({ length: TRIALS_PER_CASE }, (_, index) => ({ testCase, trial: index + 1 })),
  );
  const attempts = await mapLimit(jobs, MAX_CONCURRENT_INVOCATIONS, async ({ testCase, trial }) => {
    const observation = await gate.run(() => invoker.invokeCase(target, testCase));
    if (observation.case_id !== testCase.id) {
      throw new Error(
        `Provider observation case_id ${observation.case_id} does not match requested case ${testCase.id}`,
      );
    }
    const result = scoreCase(testCase, observation);
    return { case_id: testCase.id, trial, observation, result, passed: isPass(result) };
  });
  const observations = attempts.map((attempt) => attempt.observation);
  const behavior = scoreBehaviorEvaluation(cases, observations);
  const passedTrialCount = attempts.filter((attempt) => attempt.passed).length;
  return {
    target,
    evaluation_profile: getModelTarget(target).evaluation_profile,
    score: behavior.metrics.general_score,
    observations,
    cases: behavior.cases,
    attempts,
    attempt_count: attempts.length,
    trials_per_case: TRIALS_PER_CASE,
    case_pass_rates: behavior.metrics.case_pass_rates,
    latency_summary: behavior.metrics.latency_summary,
    total_cost_usd: behavior.metrics.total_cost_usd,
    metrics: behavior.metrics,
    tool_argument_validity_rate:
      attempts.filter((attempt) => attempt.result.tool_arguments_pass).length / attempts.length,
    passed_trial_count: passedTrialCount,
    full_trial_pass_rate: passedTrialCount / attempts.length,
    hard_contract: behavior.hard_contract,
  };
}

export async function runMigrationComparison(
  baselineTarget: ModelTargetId,
  candidateTarget: ModelTargetId,
  invoker: OrderDeskInvoker,
  cases: EvalCase[],
  verification: VerificationReport,
): Promise<MigrationComparisonResult> {
  if (baselineTarget === candidateTarget) throw new Error("Baseline and candidate must differ");
  const gate = new ConcurrencyGate(MAX_CONCURRENT_INVOCATIONS);
  const baseline = await runModelEvaluation(baselineTarget, invoker, cases, gate);
  if (!baseline.hard_contract.passed) return baselinePreflightFailure(baseline, candidateTarget);

  const candidate = await runModelEvaluation(candidateTarget, invoker, cases, gate);
  const verdict = evaluateMigration({
    candidate: candidateTarget,
    baseline: baselineTarget,
    cases,
    baseline_observations: baseline.observations,
    candidate_observations: candidate.observations,
    verification,
  });
  return {
    kind: "completed",
    baseline,
    candidate,
    verdict,
    total_cost_usd: baseline.total_cost_usd + candidate.total_cost_usd,
  };
}

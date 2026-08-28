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

export const FAILED_EVALUATION_COST_BASIS =
  "Calculated from token usage returned by completed model API responses." as const;

export interface FailedEvaluationAttemptAccounting {
  target: ModelTargetId;
  started_case_attempts: number;
  completed_case_attempts: number;
  failed_case_attempts_with_usage: number;
  failed_case_attempts_without_usage: number;
  observed_input_tokens: number;
  observed_output_tokens: number;
  observed_successful_response_cost_usd: number;
  prior_completed_models: Array<{
    target: ModelTargetId;
    completed_case_attempts: number;
    observed_input_tokens: number;
    observed_output_tokens: number;
    observed_successful_response_cost_usd: number;
  }>;
  total_observed_input_tokens: number;
  total_observed_output_tokens: number;
  total_observed_successful_response_cost_usd: number;
  cost_basis: typeof FAILED_EVALUATION_COST_BASIS;
}

class AttemptEvaluationError extends Error {
  constructor(
    readonly original_error: unknown,
    readonly observation: Observation,
  ) {
    super(original_error instanceof Error ? original_error.message : String(original_error));
    this.name = "AttemptEvaluationError";
  }
}

const MAX_PROVIDER_ERROR_MESSAGE_LENGTH = 2_000;

function boundedProviderErrorMessage(error: unknown, secrets: readonly string[]): string {
  const raw = error instanceof Error ? error.message : String(error);
  let redacted = raw;
  for (const secret of secrets) {
    if (secret.length > 0) redacted = redacted.split(secret).join("[REDACTED]");
  }
  redacted = redacted
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]");
  if (redacted.length <= MAX_PROVIDER_ERROR_MESSAGE_LENGTH) return redacted;
  return `${redacted.slice(0, MAX_PROVIDER_ERROR_MESSAGE_LENGTH - 1)}…`;
}

export class ModelEvaluationError extends Error {
  readonly original_error: { name: string; message: string };
  readonly attempt_accounting: FailedEvaluationAttemptAccounting;

  constructor(
    target: ModelTargetId,
    originalError: unknown,
    startedAttempts: number,
    completedAttempts: readonly EvaluationAttempt[],
    failedErrors: readonly unknown[],
    redactionSecrets: readonly string[] = [],
  ) {
    const unwrappedOriginal = originalError instanceof AttemptEvaluationError
      ? originalError.original_error
      : originalError;
    const original = {
      name: "EvaluationAttemptError",
      message: boundedProviderErrorMessage(unwrappedOriginal, redactionSecrets),
    };
    const failedObservations = failedErrors.flatMap((error) =>
      error instanceof AttemptEvaluationError ? [error.observation] : []
    );
    const observed = [
      ...completedAttempts.map((attempt) => attempt.observation),
      ...failedObservations,
    ];
    super(original.message);
    this.name = "ModelEvaluationError";
    this.original_error = original;
    this.attempt_accounting = {
      target,
      started_case_attempts: startedAttempts,
      completed_case_attempts: completedAttempts.length,
      failed_case_attempts_with_usage: failedObservations.length,
      failed_case_attempts_without_usage:
        startedAttempts - completedAttempts.length - failedObservations.length,
      observed_input_tokens: observed.reduce((sum, observation) => sum + observation.input_tokens, 0),
      observed_output_tokens: observed.reduce((sum, observation) => sum + observation.output_tokens, 0),
      observed_successful_response_cost_usd: observed.reduce(
        (sum, observation) => sum + observation.cost_usd,
        0,
      ),
      prior_completed_models: [],
      total_observed_input_tokens: observed.reduce(
        (sum, observation) => sum + observation.input_tokens,
        0,
      ),
      total_observed_output_tokens: observed.reduce(
        (sum, observation) => sum + observation.output_tokens,
        0,
      ),
      total_observed_successful_response_cost_usd: observed.reduce(
        (sum, observation) => sum + observation.cost_usd,
        0,
      ),
      cost_basis: FAILED_EVALUATION_COST_BASIS,
    };
  }

  addPriorCompletedModel(report: ModelEvaluationReport): this {
    const summary = {
      target: report.target,
      completed_case_attempts: report.attempt_count,
      observed_input_tokens: report.observations.reduce(
        (sum, observation) => sum + observation.input_tokens,
        0,
      ),
      observed_output_tokens: report.observations.reduce(
        (sum, observation) => sum + observation.output_tokens,
        0,
      ),
      observed_successful_response_cost_usd: report.total_cost_usd,
    };
    this.attempt_accounting.prior_completed_models.push(summary);
    this.attempt_accounting.total_observed_input_tokens += summary.observed_input_tokens;
    this.attempt_accounting.total_observed_output_tokens += summary.observed_output_tokens;
    this.attempt_accounting.total_observed_successful_response_cost_usd +=
      summary.observed_successful_response_cost_usd;
    return this;
  }
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
    await new Promise<void>((resolve) => {
      if (this.active < this.limit) {
        this.active += 1;
        resolve();
      } else {
        this.waiting.push(resolve);
      }
    });
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) {
        next();
      } else {
        this.active -= 1;
      }
    }
  }
}

class MapLimitError<R> extends Error {
  constructor(
    readonly original_error: unknown,
    readonly started: number,
    readonly completed: readonly R[],
    readonly failures: readonly unknown[],
  ) {
    super(original_error instanceof Error ? original_error.message : String(original_error));
    this.name = "MapLimitError";
  }
}

async function mapLimit<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  const completed: R[] = [];
  let cursor = 0;
  let started = 0;
  let failed = false;
  let firstError: unknown;
  const failures: unknown[] = [];

  async function runWorker(): Promise<void> {
    while (!failed) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      started += 1;
      try {
        const value = await worker(items[index]!);
        output[index] = value;
        completed.push(value);
      } catch (error) {
        failures.push(error);
        if (!failed) {
          failed = true;
          firstError = error;
        }
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runWorker()));
  if (failed) throw new MapLimitError(firstError, started, completed, failures);
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
  const redactionSecrets = invoker.redactionSecrets?.(target) ?? [];
  const jobs = cases.flatMap((testCase) =>
    Array.from({ length: TRIALS_PER_CASE }, (_, index) => ({ testCase, trial: index + 1 })),
  );
  let attempts: EvaluationAttempt[];
  try {
    attempts = await mapLimit(jobs, MAX_CONCURRENT_INVOCATIONS, async ({ testCase, trial }) => {
      const observation = await gate.run(() => invoker.invokeCase(target, testCase));
      try {
        if (observation.case_id !== testCase.id) {
          throw new Error(
            `Provider observation case_id ${observation.case_id} does not match requested case ${testCase.id}`,
          );
        }
        const result = scoreCase(testCase, observation);
        return { case_id: testCase.id, trial, observation, result, passed: isPass(result) };
      } catch (error) {
        throw new AttemptEvaluationError(error, observation);
      }
    });
  } catch (error) {
    if (!(error instanceof MapLimitError)) throw error;
    throw new ModelEvaluationError(
      target,
      error.original_error,
      error.started,
      error.completed as readonly EvaluationAttempt[],
      error.failures,
      redactionSecrets,
    );
  }
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
  if (verification.status !== "verified") {
    throw new Error("sandbox verification must pass before paid evaluation");
  }
  const gate = new ConcurrencyGate(MAX_CONCURRENT_INVOCATIONS);
  const baseline = await runModelEvaluation(baselineTarget, invoker, cases, gate);
  if (!baseline.hard_contract.passed) return baselinePreflightFailure(baseline, candidateTarget);

  let candidate: ModelEvaluationReport;
  try {
    candidate = await runModelEvaluation(candidateTarget, invoker, cases, gate);
  } catch (error) {
    if (error instanceof ModelEvaluationError) error.addPriorCompletedModel(baseline);
    throw error;
  }
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

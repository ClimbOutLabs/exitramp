import type {
  CaseResult,
  EvalCase,
  MigrationVerdict,
  Observation,
} from "../domain/schemas.js";
import type { ModelTargetId } from "../providers/catalog.js";
import type { OrderDeskInvoker } from "../providers/adapter.js";
import { evaluateMigration, TRIALS_PER_CASE } from "./policy.js";
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
  score: number;
  observations: Observation[];
  cases: CaseResult[];
  attempts: EvaluationAttempt[];
  attempt_count: number;
  trials_per_case: typeof TRIALS_PER_CASE;
  case_pass_rates: Array<{ case_id: string; critical: boolean; attempts: number; passes: number; pass_rate: number }>;
  latency_summary: { min_ms: number; mean_ms: number; p95_ms: number; max_ms: number };
  total_cost_usd: number;
}

export interface MigrationComparison {
  baseline: ModelEvaluationReport;
  candidate: ModelEvaluationReport;
  verdict: MigrationVerdict;
  total_cost_usd: number;
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function isPass(result: CaseResult): boolean {
  return result.schema_valid && result.tool_selection_pass && result.tool_arguments_pass &&
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

function latencySummary(observations: Observation[]): ModelEvaluationReport["latency_summary"] {
  const values = observations.map((observation) => observation.latency_ms).sort((left, right) => left - right);
  if (values.length === 0) return { min_ms: 0, mean_ms: 0, p95_ms: 0, max_ms: 0 };
  return {
    min_ms: values[0]!,
    mean_ms: average(values),
    p95_ms: values[Math.ceil(values.length * 0.95) - 1]!,
    max_ms: values.at(-1)!,
  };
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
    const result = scoreCase(testCase, observation);
    return { case_id: testCase.id, trial, observation, result, passed: isPass(result) };
  });
  const observations = attempts.map((attempt) => attempt.observation);
  const results = cases.map((testCase) => {
    const caseAttempts = attempts.filter((attempt) => attempt.case_id === testCase.id);
    return {
      case_id: testCase.id,
      critical: testCase.critical,
      schema_valid: caseAttempts.every((attempt) => attempt.result.schema_valid),
      tool_selection_pass: caseAttempts.every((attempt) => attempt.result.tool_selection_pass),
      tool_arguments_pass: caseAttempts.every((attempt) => attempt.result.tool_arguments_pass),
      grounding_pass: caseAttempts.every((attempt) => attempt.result.grounding_pass),
      prohibited_actions_pass: caseAttempts.every((attempt) => attempt.result.prohibited_actions_pass),
      decision_pass: caseAttempts.every((attempt) => attempt.result.decision_pass),
      score: average(caseAttempts.map((attempt) => attempt.result.score)),
      failures: [...new Set(caseAttempts.flatMap((attempt) => attempt.result.failures))].sort(),
    };
  });
  const casePassRates = cases.map((testCase) => {
    const caseAttempts = attempts.filter((attempt) => attempt.case_id === testCase.id);
    const passes = caseAttempts.filter((attempt) => attempt.passed).length;
    return { case_id: testCase.id, critical: testCase.critical, attempts: TRIALS_PER_CASE, passes, pass_rate: passes / TRIALS_PER_CASE };
  });
  return {
    target,
    score: average(results.map((result) => result.score)),
    observations,
    cases: results,
    attempts,
    attempt_count: attempts.length,
    trials_per_case: TRIALS_PER_CASE,
    case_pass_rates: casePassRates,
    latency_summary: latencySummary(observations),
    total_cost_usd: observations.reduce((sum, observation) => sum + observation.cost_usd, 0),
  };
}

export async function runMigrationComparison(
  baselineTarget: ModelTargetId,
  candidateTarget: ModelTargetId,
  invoker: OrderDeskInvoker,
  cases: EvalCase[],
  verification: VerificationReport,
): Promise<MigrationComparison> {
  if (baselineTarget === candidateTarget) throw new Error("Baseline and candidate must differ");
  const gate = new ConcurrencyGate(MAX_CONCURRENT_INVOCATIONS);
  const [baseline, candidate] = await Promise.all([
    runModelEvaluation(baselineTarget, invoker, cases, gate),
    runModelEvaluation(candidateTarget, invoker, cases, gate),
  ]);
  const verdict = evaluateMigration({
    candidate: candidateTarget,
    baseline: baselineTarget,
    cases,
    baseline_observations: baseline.observations,
    candidate_observations: candidate.observations,
    verification,
  });
  return {
    baseline,
    candidate,
    verdict,
    total_cost_usd: baseline.total_cost_usd + candidate.total_cost_usd,
  };
}

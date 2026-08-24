import type {
  CaseResult,
  EvalCase,
  MigrationVerdict,
  Observation,
} from "../domain/schemas.js";
import type { ModelTargetId } from "../providers/catalog.js";
import type { OrderDeskInvoker } from "../providers/adapter.js";
import { ORDERDESK_CASES } from "./corpus.js";
import { evaluateMigration } from "./policy.js";
import { scoreCase } from "./scorer.js";

export interface ModelEvaluationReport {
  target: ModelTargetId;
  score: number;
  observations: Observation[];
  cases: CaseResult[];
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

export async function runModelEvaluation(
  target: ModelTargetId,
  invoker: OrderDeskInvoker,
  cases: EvalCase[] = ORDERDESK_CASES,
): Promise<ModelEvaluationReport> {
  if (cases.length === 0 || cases.length > 20) throw new Error("Evaluation case count must be 1-20");
  const observations: Observation[] = [];
  for (const testCase of cases) observations.push(await invoker.invokeCase(target, testCase));
  const results = cases.map((testCase, index) => scoreCase(testCase, observations[index]!));
  return {
    target,
    score: average(results.map((result) => result.score)),
    observations,
    cases: results,
    total_cost_usd: observations.reduce((sum, observation) => sum + observation.cost_usd, 0),
  };
}

export async function runMigrationComparison(
  baselineTarget: ModelTargetId,
  candidateTarget: ModelTargetId,
  repositoryTestsPassed: boolean,
  invoker: OrderDeskInvoker,
): Promise<MigrationComparison> {
  if (baselineTarget === candidateTarget) throw new Error("Baseline and candidate must differ");
  const baseline = await runModelEvaluation(baselineTarget, invoker);
  const candidate = await runModelEvaluation(candidateTarget, invoker);
  const verdict = evaluateMigration({
    candidate: candidateTarget,
    baseline_score: baseline.score,
    repository_tests_passed: repositoryTestsPassed,
    adapter_tests_passed: true,
    cases: ORDERDESK_CASES,
    observations: candidate.observations,
  });
  return {
    baseline,
    candidate,
    verdict,
    total_cost_usd: baseline.total_cost_usd + candidate.total_cost_usd,
  };
}

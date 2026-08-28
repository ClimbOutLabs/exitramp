import { createServer } from "node:http";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod/v4";

import {
  FAILED_EVALUATION_COST_BASIS,
  ModelEvaluationError,
  runMigrationComparison,
  type BaselinePreflightFailure,
  type MigrationComparison,
  type ModelEvaluationReport,
} from "../eval/live-runner.js";
import { EvidenceStore, type EvidenceEnvelope } from "../eval/evidence-store.js";
import {
  bindOrderDeskBehaviorSnapshot,
  compileOrderDeskScenarioPlan,
  type CompiledScenarioSet,
} from "../eval/scenario-authoring.js";
import {
  SandboxVerificationReceiptSchema,
  VERIFICATION_COMMAND_PLAN,
  verifySandboxReceipts,
  type SandboxVerificationReceipt,
  type VerificationReport,
} from "../eval/verification.js";
import {
  BehaviorSnapshotSchema,
  ScenarioRepositoryBindingSchema,
  ScenarioPlanSchema,
  type BehaviorSnapshot,
  type ScenarioRepositoryBinding,
  type ScenarioPlan,
} from "../domain/schemas.js";
import { canonicalJson } from "../domain/canonical.js";
import { LiveOrderDeskAdapter, type OrderDeskInvoker } from "../providers/adapter.js";
import { getModelTarget, MODEL_TARGETS, ModelTargetIdSchema, type ModelTargetId } from "../providers/catalog.js";
import { TRIALS_PER_CASE } from "../eval/policy.js";
import { RepositorySnapshotSchema, snapshotRepository, type RepositorySnapshot } from "./github.js";

const PORT = Number.parseInt(process.env.PORT ?? "8788", 10);

const EvidenceIdSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const EVALUATION_CASE_COUNT = 10 as const;
export const EVALUATION_TRIALS_PER_CASE = TRIALS_PER_CASE;
export const BASELINE_TRIAL_COUNT = EVALUATION_CASE_COUNT * EVALUATION_TRIALS_PER_CASE;
export const CANDIDATE_TRIAL_COUNT = BASELINE_TRIAL_COUNT;
export const MAX_EVALUATION_TRIAL_COUNT = BASELINE_TRIAL_COUNT + CANDIDATE_TRIAL_COUNT;
/** Every configured adapter makes at most max_tool_rounds requests per trial. */
export const MAX_PROVIDER_REQUESTS_PER_TRIAL = Math.max(
  ...Object.values(MODEL_TARGETS).map((target) => target.evaluation_profile.max_tool_rounds),
);
export const MAX_EVALUATION_PROVIDER_REQUESTS =
  MAX_EVALUATION_TRIAL_COUNT * MAX_PROVIDER_REQUESTS_PER_TRIAL;
export const APPROVAL_BOUNDARY =
  "TrueForge supplies the actual human approval boundary; ExitRamp supplies immutable preflight context." as const;
const ScenarioSuiteReferenceSchema = z.object({
  label: z.string().min(1).max(120),
  summary: z.string().min(1).max(500),
  case_count: z.number().int().min(1).max(100),
  technical_evidence_id: EvidenceIdSchema.describe("Immutable SHA-256 evidence ID for the frozen scenario suite."),
}).strict();
const VerifiedBuildReferenceSchema = z.object({
  label: z.string().min(1).max(120),
  summary: z.string().min(1).max(500),
  verification_scope: z.string().min(1).max(500),
  commit_sha: z.string().min(1).max(200),
  status: z.enum(["verified", "rejected"]),
  technical_evidence_id: EvidenceIdSchema.describe("Immutable SHA-256 evidence ID for the sandbox verification artifact."),
}).strict();
const ApprovalTargetSchema = z.object({
  id: ModelTargetIdSchema,
  display_name: z.string().min(1).max(120),
}).strict();

const ApprovalWorkloadSchema = z.object({
  cases: z.literal(EVALUATION_CASE_COUNT),
  trials_per_case: z.literal(EVALUATION_TRIALS_PER_CASE),
  baseline_trials: z.literal(BASELINE_TRIAL_COUNT),
  candidate_trials_if_baseline_passes: z.literal(CANDIDATE_TRIAL_COUNT),
  maximum_trials: z.literal(MAX_EVALUATION_TRIAL_COUNT),
  maximum_provider_requests: z.literal(MAX_EVALUATION_PROVIDER_REQUESTS),
}).strict();

const APPROVAL_SUMMARY =
  "Compare an allowlisted baseline with a candidate on the frozen OrderDesk safety suite." as const;
const APPROVAL_ACTION =
  "Run the paid OrderDesk comparison only after TrueForge records explicit human approval." as const;
const BASELINE_STOP_RULE =
  "Stop after the baseline if it fails the hard behavior contract; do not run the candidate." as const;
const COST_ACCOUNTING =
  "Estimated cost is calculated from token usage returned by completed model API responses." as const;
const DATA_IMPACT =
  "Writes immutable evaluation evidence. Cannot change repository, customer data, deployments, or migrations." as const;

export const MigrationEvaluationApprovalManifestSchema = z.object({
  schema_version: z.literal(1),
  baseline_target: ApprovalTargetSchema,
  candidate_target: ApprovalTargetSchema,
  scenario_suite: ScenarioSuiteReferenceSchema,
  verified_build: VerifiedBuildReferenceSchema,
  repository_snapshot_evidence_id: EvidenceIdSchema,
  commit_sha: z.string().min(1).max(200),
  workload: ApprovalWorkloadSchema,
  summary: z.literal(APPROVAL_SUMMARY),
  action: z.literal(APPROVAL_ACTION),
  baseline_stop_rule: z.literal(BASELINE_STOP_RULE),
  cost_accounting: z.literal(COST_ACCOUNTING),
  data_impact: z.literal(DATA_IMPACT),
  approval_boundary: z.literal(
    "TrueForge supplies the actual human approval boundary; ExitRamp supplies immutable preflight context.",
  ),
}).strict();

export type MigrationEvaluationApprovalManifest = z.infer<
  typeof MigrationEvaluationApprovalManifestSchema
>;
// Short aliases keep the approval contract discoverable to MCP integrations.
export const ApprovalManifestSchema = MigrationEvaluationApprovalManifestSchema;

/**
 * TrueForge v0.1.3 renders gated MCP arguments verbatim. Keep this request
 * compact and human-facing; the complete manifest remains in immutable evidence.
 */
export const MigrationEvaluationApprovalRequestSchema = z.object({
  Decision: z.literal("Start the paid OrderDesk model comparison"),
  Models: z.string().min(1).max(300),
  "Code version": z.string().min(1).max(300),
  "Test plan": z.string().min(1).max(500),
  "Request cap": z.string().min(1).max(500),
  "Checks completed": z.string().min(1).max(500),
  Output: z.string().min(1).max(500),
  Constraints: z.string().min(1).max(500),
  "Approval record": EvidenceIdSchema,
}).strict();

export type MigrationEvaluationApprovalRequest = z.infer<
  typeof MigrationEvaluationApprovalRequestSchema
>;
export const ApprovalRequestSchema = MigrationEvaluationApprovalRequestSchema;

/**
 * An approval manifest may authorize exactly one paid evaluation.  This is
 * deliberately a distinct error so callers can explain that a fresh
 * approval is required instead of retrying the same request.
 */
export class ApprovalAlreadyConsumedError extends Error {
  readonly error_code = "APPROVAL_ALREADY_CONSUMED" as const;

  constructor(public readonly manifest_evidence_id: string) {
    super(
      `Approval manifest ${manifest_evidence_id} has already been consumed; ` +
        "prepare a new approval before another paid evaluation.",
    );
    this.name = "ApprovalAlreadyConsumedError";
  }
}

export const PrepareMigrationEvaluationApprovalInputSchema = z.object({
  baseline_target: ModelTargetIdSchema,
  candidate_target: ModelTargetIdSchema,
  scenario_suite: ScenarioSuiteReferenceSchema.describe(
    "Human-readable frozen scenario-suite reference. ExitRamp validates every field against immutable evidence.",
  ),
  verified_build: VerifiedBuildReferenceSchema.describe(
    "Human-readable sandbox-build reference. ExitRamp validates every field against immutable evidence.",
  ),
}).strict();

export const RunMigrationEvaluationInputSchema = z.object({
  approval_request: MigrationEvaluationApprovalRequestSchema,
}).strict();

/**
 * The author submits only `plan`; the repository reference is resolved by the
 * trusted MCP layer and is never model-authored scenario metadata.
 */
export const CompileOrderDeskScenarioPlanInputSchema = z.object({
  repository_snapshot_evidence_id: EvidenceIdSchema.describe(
    "Immutable repository snapshot evidence ID. The compiler binds the scenario suite to this exact resolved commit.",
  ),
  plan: ScenarioPlanSchema,
}).strict();

export const RecordSandboxVerificationInputSchema = z.object({
  repository_snapshot_evidence_id: EvidenceIdSchema,
  // Partial/duplicate receipts are retained as rejected evidence so a failed
  // sandbox run remains reviewable; verifySandboxReceipts enforces the full plan.
  verification_receipts: z.array(SandboxVerificationReceiptSchema).min(1).max(10),
}).strict();

const VerificationReportPayloadSchema = z.object({
  status: z.enum(["verified", "rejected"]),
  expected_commit_sha: z.string().min(1).max(200),
  command_plan: z.array(z.object({ id: z.string().min(1), command: z.string().min(1) }).strict()).length(VERIFICATION_COMMAND_PLAN.length),
  receipts: z.array(SandboxVerificationReceiptSchema).min(1).max(10),
  failed_gates: z.array(z.string()),
  evidence_id: EvidenceIdSchema,
  sandbox_id: z.string().min(1).max(200),
  repository_snapshot_evidence_id: EvidenceIdSchema,
}).strict();

const EvaluationErrorSchema = z.object({
  status: z.literal("error"),
  reason: z.literal("provider evaluation failed"),
  error: z.object({
    name: z.string().min(1).max(200),
    message: z.string().max(2_000),
  }).strict(),
  scenario_set_id: z.string().min(1),
  repository_snapshot_evidence_id: EvidenceIdSchema,
  commit_sha: z.string().min(1),
  approval_manifest_evidence_id: EvidenceIdSchema,
  attempt_accounting: z.object({
    target: ModelTargetIdSchema,
    started_case_attempts: z.number().int().nonnegative(),
    completed_case_attempts: z.number().int().nonnegative(),
    failed_case_attempts_with_usage: z.number().int().nonnegative(),
    failed_case_attempts_without_usage: z.number().int().nonnegative(),
    observed_input_tokens: z.number().int().nonnegative(),
    observed_output_tokens: z.number().int().nonnegative(),
    observed_successful_response_cost_usd: z.number().nonnegative(),
    prior_completed_models: z.array(z.object({
      target: ModelTargetIdSchema,
      completed_case_attempts: z.number().int().nonnegative(),
      observed_input_tokens: z.number().int().nonnegative(),
      observed_output_tokens: z.number().int().nonnegative(),
      observed_successful_response_cost_usd: z.number().nonnegative(),
    }).strict()).max(1),
    total_observed_input_tokens: z.number().int().nonnegative(),
    total_observed_output_tokens: z.number().int().nonnegative(),
    total_observed_successful_response_cost_usd: z.number().nonnegative(),
    cost_basis: z.literal(FAILED_EVALUATION_COST_BASIS),
  }).strict().nullable(),
}).strict();

export interface McpServerOptions {
  evidence_store?: EvidenceStore;
  /** Injectable evaluator for deterministic integration tests and local adapters. */
  invoker?: OrderDeskInvoker;
}

/** Human-facing frozen suite reference used on the paid-evaluation approval card. */
export interface ScenarioSuiteReference {
  label: string;
  summary: string;
  case_count: number;
  technical_evidence_id: string;
}

/** Human-facing sandbox verification reference used on the paid-evaluation approval card. */
export interface VerifiedBuildReference {
  label: string;
  summary: string;
  /** Plain-language limit on what this evidence can prove. */
  verification_scope: string;
  commit_sha: string;
  status: "verified" | "rejected";
  technical_evidence_id: string;
}

export const JUDGE_REPORT_VERSION = "judge-report-v1" as const;

const MEASURED_USAGE_COST_BASIS =
  "Calculated from token usage returned by completed model API responses." as const;
const INTERNAL_DIGEST_LOCATION =
  "Stored in raw details of the immutable evaluation evidence artifact." as const;

export interface TrialCountSummary {
  attempted_trials: number;
  passed_trials: number;
  full_trial_pass_rate: number | null;
}

export interface CasePassRateSummary {
  case_id: string;
  critical: boolean;
  attempted_trials: number;
  passed_trials: number;
  pass_rate: number;
}

export interface BehaviorMetricRate {
  label: string;
  pass_rate: number;
}

export interface BehaviorMetricSummary {
  structured_output: BehaviorMetricRate;
  critical_tool_behavior: BehaviorMetricRate;
  tool_argument_validity: BehaviorMetricRate;
  typed_grounding: BehaviorMetricRate;
  full_trial_pass: BehaviorMetricRate;
  prohibited_action_safety: BehaviorMetricRate;
  prohibited_tool_safety: BehaviorMetricRate;
  prohibited_tool_calls: {
    label: "Prohibited tool calls";
    count: number;
  };
}

export interface EvaluatedModelHumanReport {
  model_id: string;
  /** Compact pointer to the detailed immutable profile retained in raw evidence. */
  evaluation_profile_version: string;
  execution_status: "evaluated";
  general_score: number;
  case_pass_rates: CasePassRateSummary[];
  behavior_metrics: BehaviorMetricSummary;
  latency_summary: ModelEvaluationReport["latency_summary"];
  estimated_cost_usd: number;
  hard_contract: {
    status: "passed" | "failed";
    failed_gates: string[];
  };
}

export interface SkippedModelHumanReport {
  model_id: string;
  execution_status: "skipped";
  reason: "Candidate not run because the baseline failed the hard behavior contract.";
  estimated_cost_usd: 0;
}

interface HumanReportBase {
  report_version: typeof JUDGE_REPORT_VERSION;
  scenario_suite: ScenarioSuiteReference;
  verified_build: VerifiedBuildReference;
  case_count: number;
  trials_per_case: number;
  models_configured: 2;
  models_run: 1 | 2;
  candidate_ran: boolean;
  trial_counts: {
    baseline: TrialCountSummary;
    candidate: TrialCountSummary;
    total: TrialCountSummary;
  };
  total_estimated_cost_usd: number;
  cost_basis: typeof MEASURED_USAGE_COST_BASIS;
  failed_gates: string[];
  next_step: string;
}

export interface CompletedEvaluationHumanReport extends HumanReportBase {
  status: "completed";
  verdict: {
    status: "eligible" | "rejected";
    label: "Eligible for migration" | "Rejected for migration";
    required_general_score: number;
  };
  models_run: 2;
  candidate_ran: true;
  models: {
    baseline: EvaluatedModelHumanReport;
    candidate: EvaluatedModelHumanReport;
  };
}

export interface BaselineRejectedEvaluationHumanReport extends HumanReportBase {
  status: "baseline_rejected";
  verdict: {
    status: "rejected";
    label: "Baseline rejected; candidate not run";
  };
  models_run: 1;
  candidate_ran: false;
  models: {
    baseline: EvaluatedModelHumanReport;
    candidate: SkippedModelHumanReport;
  };
  next_step: "No comparison or migration was performed. Review the failed baseline evidence before any separate migration decision.";
}

export type EvaluationHumanReport =
  | CompletedEvaluationHumanReport
  | BaselineRejectedEvaluationHumanReport;

export interface EvaluationTechnicalDetails {
  /** Immutable content-addressed evaluation envelope, distinct from internal digests. */
  evaluation_envelope_id: string;
  /** The internal report digest is retained in immutable evidence, not returned inline. */
  internal_report_digest_location: typeof INTERNAL_DIGEST_LOCATION;
}

export interface EvaluationPrimaryResponse {
  report_version: typeof JUDGE_REPORT_VERSION;
  status: EvaluationHumanReport["status"];
  scenario_suite: ScenarioSuiteReference;
  verified_build: VerifiedBuildReference;
  human_report: EvaluationHumanReport;
  technical_details: EvaluationTechnicalDetails;
}

export interface CompletedEvaluationArtifact {
  human_report: CompletedEvaluationHumanReport;
  raw_details: {
    scenario_set_id: string;
    repository_snapshot_evidence_id: string;
    commit_sha: string;
    approval_manifest_evidence_id: string;
    /** Internal evaluator digest, distinct from the enclosing EvidenceStore ID. */
    internal_report_digest: string;
    comparison: MigrationComparison;
  };
}

export interface BaselineRejectedEvaluationArtifact {
  human_report: BaselineRejectedEvaluationHumanReport;
  raw_details: {
    scenario_set_id: string;
    repository_snapshot_evidence_id: string;
    commit_sha: string;
    approval_manifest_evidence_id: string;
    /** Internal evaluator digest, distinct from the enclosing EvidenceStore ID. */
    internal_report_digest: string;
    baseline_preflight: BaselinePreflightFailure;
  };
}

export interface PersistCompletedEvaluationInput {
  approval_manifest_evidence_id: string;
  scenario_evidence_id: string;
  verification_evidence_id: string;
  scenario_set_id: string;
  repository_snapshot_evidence_id: string;
  commit_sha: string;
  case_count: number;
  scenario_suite: ScenarioSuiteReference;
  verified_build: VerifiedBuildReference;
  comparison: MigrationComparison;
}

export interface PersistBaselineRejectedEvaluationInput {
  approval_manifest_evidence_id: string;
  scenario_evidence_id: string;
  verification_evidence_id: string;
  scenario_set_id: string;
  repository_snapshot_evidence_id: string;
  commit_sha: string;
  case_count: number;
  scenario_suite: ScenarioSuiteReference;
  verified_build: VerifiedBuildReference;
  baseline_failure: BaselinePreflightFailure;
}

export interface CompiledScenarioEvidence {
  /** Immutable repository snapshot to which this compiled suite is bound. */
  repository_snapshot_evidence_id: string;
  /** Resolved commit from that repository snapshot, retained for audit. */
  repository_commit_sha: string;
  /** Versioned trusted behavior snapshot used by the private compiler. */
  behavior_snapshot_id: string;
  /** Trusted behavior-contract version recorded with the snapshot. */
  behavior_contract_version: string;
  /** Private compiler version that rendered the executable prompts and oracles. */
  compiler_version: string;
  snapshot_evidence_id: string;
  plan_evidence_id: string;
  /** Backward-compatible alias for the canonical field below. */
  compiled_evidence_id: string;
  /** Immutable SHA-256 technical detail for audit and integrations. */
  compiled_scenario_evidence_id: string;
  scenario_suite: ScenarioSuiteReference;
  scenario_set_id: string;
  cases: Array<{ id: string; prompt: string; critical: boolean }>;
}

export interface RepositorySnapshotEvidence extends RepositorySnapshot {
  repository_snapshot_evidence_id: string;
}

export interface SandboxVerificationEvidence extends VerificationReport {
  repository_snapshot_evidence_id: string;
  verification_evidence_id: string;
  verified_build: VerifiedBuildReference;
}

function scenarioSuiteReference(evidenceId: string, caseCount: number): ScenarioSuiteReference {
  return {
    label: "OrderDesk adversarial safety suite",
    summary: `${caseCount} tough cases covering order status, damaged items, refund pressure, duplicate charges, and subscription cancellation.`,
    case_count: caseCount,
    technical_evidence_id: evidenceId,
  };
}

const STRUCTURAL_RECEIPT_VERIFICATION_SCOPE =
  "Structural receipt validation only; ExitRamp did not launch or cryptographically attest the sandbox.";

function verifiedBuildReference(report: VerificationReport, evidenceId: string): VerifiedBuildReference {
  const receiptSource = "caller-supplied sandbox receipts";
  const commands = report.command_plan.map((command) => command.command).join(" and ");
  const verified = report.status === "verified";
  return {
    label: verified ? "Receipt-verified source checks" : "Receipt checks did not pass",
    summary: verified
      ? `Commit ${report.expected_commit_sha} passed ${commands} according to ${receiptSource}.`
      : `Commit ${report.expected_commit_sha} did not pass ${commands} according to ${receiptSource}.`,
    verification_scope: STRUCTURAL_RECEIPT_VERIFICATION_SCOPE,
    commit_sha: report.expected_commit_sha,
    status: report.status,
    technical_evidence_id: evidenceId,
  };
}

function assertDisplayReferenceMatches(actual: unknown, expected: unknown, field: string): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${field} does not match immutable evidence`);
  }
}

function trialCountSummary(report: ModelEvaluationReport): TrialCountSummary {
  return {
    attempted_trials: report.attempt_count,
    passed_trials: report.passed_trial_count,
    full_trial_pass_rate: report.full_trial_pass_rate,
  };
}

function combineTrialCounts(
  baseline: TrialCountSummary,
  candidate: TrialCountSummary,
): TrialCountSummary {
  const attemptedTrials = baseline.attempted_trials + candidate.attempted_trials;
  const passedTrials = baseline.passed_trials + candidate.passed_trials;
  return {
    attempted_trials: attemptedTrials,
    passed_trials: passedTrials,
    full_trial_pass_rate: attemptedTrials === 0 ? null : passedTrials / attemptedTrials,
  };
}

function modelHumanReport(report: ModelEvaluationReport): EvaluatedModelHumanReport {
  return {
    model_id: report.target,
    evaluation_profile_version: report.evaluation_profile.profile_version,
    execution_status: "evaluated",
    general_score: report.score,
    case_pass_rates: report.case_pass_rates.map((caseRate) => ({
      case_id: caseRate.case_id,
      critical: caseRate.critical,
      attempted_trials: caseRate.attempts,
      passed_trials: caseRate.passes,
      pass_rate: caseRate.pass_rate,
    })),
    behavior_metrics: {
      structured_output: {
        label: "Structured output",
        pass_rate: report.metrics.structured_output_rate,
      },
      critical_tool_behavior: {
        label: "Critical tool behavior",
        pass_rate: report.metrics.critical_tool_rate,
      },
      tool_argument_validity: {
        label: "Tool argument validity",
        pass_rate: report.tool_argument_validity_rate,
      },
      typed_grounding: {
        label: "Typed grounding",
        pass_rate: report.metrics.grounding_rate,
      },
      full_trial_pass: {
        label: "Full-trial pass",
        pass_rate: report.full_trial_pass_rate,
      },
      prohibited_action_safety: {
        label: "Prohibited-action safety",
        pass_rate: report.metrics.prohibited_action_rate,
      },
      prohibited_tool_safety: {
        label: "Prohibited-tool safety",
        pass_rate: report.metrics.prohibited_tool_calls === 0 ? 1 : 0,
      },
      prohibited_tool_calls: {
        label: "Prohibited tool calls",
        count: report.metrics.prohibited_tool_calls,
      },
    },
    latency_summary: report.latency_summary,
    estimated_cost_usd: report.total_cost_usd,
    hard_contract: {
      status: report.hard_contract.passed ? "passed" : "failed",
      failed_gates: [...report.hard_contract.failed_gates],
    },
  };
}

function assertCompletedComparisonAccounting(
  comparison: MigrationComparison,
  caseCount: number,
): void {
  const trialsPerCase = comparison.baseline.trials_per_case;
  const attemptsPerModel = comparison.baseline.attempt_count;
  if (
    !comparison.baseline.hard_contract.passed ||
    comparison.candidate.trials_per_case !== trialsPerCase ||
    comparison.candidate.attempt_count !== attemptsPerModel ||
    attemptsPerModel !== caseCount * trialsPerCase ||
    comparison.total_cost_usd !== comparison.baseline.total_cost_usd + comparison.candidate.total_cost_usd
  ) {
    throw new Error("Migration comparison has inconsistent attempt accounting");
  }
}

export function buildCompletedEvaluationHumanReport(
  comparison: MigrationComparison,
  scenarioSuite: ScenarioSuiteReference,
  verifiedBuild: VerifiedBuildReference,
  caseCount: number,
): CompletedEvaluationHumanReport {
  assertCompletedComparisonAccounting(comparison, caseCount);
  const trialsPerCase = comparison.baseline.trials_per_case;
  const baselineTrials = trialCountSummary(comparison.baseline);
  const candidateTrials = trialCountSummary(comparison.candidate);
  return {
    report_version: JUDGE_REPORT_VERSION,
    status: "completed",
    scenario_suite: scenarioSuite,
    verified_build: verifiedBuild,
    case_count: caseCount,
    trials_per_case: trialsPerCase,
    verdict: {
      status: comparison.verdict.status,
      label: comparison.verdict.status === "eligible" ? "Eligible for migration" : "Rejected for migration",
      required_general_score: comparison.verdict.required_general_score,
    },
    models_configured: 2,
    models_run: 2,
    candidate_ran: true,
    trial_counts: {
      baseline: baselineTrials,
      candidate: candidateTrials,
      total: combineTrialCounts(baselineTrials, candidateTrials),
    },
    models: {
      baseline: modelHumanReport(comparison.baseline),
      candidate: modelHumanReport(comparison.candidate),
    },
    total_estimated_cost_usd: comparison.total_cost_usd,
    cost_basis: MEASURED_USAGE_COST_BASIS,
    failed_gates: [...comparison.verdict.failed_gates],
    next_step:
      comparison.verdict.status === "eligible"
        ? "Eligibility is evidence only; a separate approval/apply system must decide, and this repository applied nothing."
        : "Do not migrate this candidate; review the failed gates and immutable evidence.",
  };
}

function assertBaselinePreflightAccounting(
  failure: BaselinePreflightFailure,
  caseCount: number,
): void {
  const expectedAttempts = caseCount * failure.baseline.trials_per_case;
  if (failure.baseline.hard_contract.passed || failure.baseline_failed_gates.length === 0) {
    throw new Error("Baseline preflight rejection must include a failed hard-contract gate");
  }
  if (
    failure.baseline_attempts !== expectedAttempts ||
    failure.baseline.attempt_count !== expectedAttempts ||
    failure.candidate_attempts !== 0 ||
    failure.total_model_attempts !== expectedAttempts
  ) {
    throw new Error("Baseline preflight has inconsistent attempt accounting");
  }
  if (failure.total_cost_usd !== failure.baseline.total_cost_usd) {
    throw new Error("Baseline preflight total cost must equal the baseline cost");
  }
}

export function buildBaselineRejectedEvaluationHumanReport(
  failure: BaselinePreflightFailure,
  scenarioSuite: ScenarioSuiteReference,
  verifiedBuild: VerifiedBuildReference,
  caseCount: number,
): BaselineRejectedEvaluationHumanReport {
  assertBaselinePreflightAccounting(failure, caseCount);
  const baselineTrials = trialCountSummary(failure.baseline);
  const candidateTrials: TrialCountSummary = {
    attempted_trials: 0,
    passed_trials: 0,
    full_trial_pass_rate: null,
  };
  return {
    report_version: JUDGE_REPORT_VERSION,
    status: "baseline_rejected",
    scenario_suite: scenarioSuite,
    verified_build: verifiedBuild,
    case_count: caseCount,
    trials_per_case: failure.baseline.trials_per_case,
    verdict: {
      status: "rejected",
      label: "Baseline rejected; candidate not run",
    },
    models_configured: 2,
    models_run: 1,
    candidate_ran: false,
    trial_counts: {
      baseline: baselineTrials,
      candidate: candidateTrials,
      total: combineTrialCounts(baselineTrials, candidateTrials),
    },
    models: {
      baseline: modelHumanReport(failure.baseline),
      candidate: {
        model_id: failure.candidate_target,
        execution_status: "skipped",
        reason: "Candidate not run because the baseline failed the hard behavior contract.",
        estimated_cost_usd: 0,
      },
    },
    total_estimated_cost_usd: failure.total_cost_usd,
    cost_basis: MEASURED_USAGE_COST_BASIS,
    failed_gates: [...failure.baseline_failed_gates],
    next_step:
      "No comparison or migration was performed. Review the failed baseline evidence before any separate migration decision.",
  };
}

export function buildEvaluationPrimaryResponse(
  humanReport: EvaluationHumanReport,
  evaluationEnvelopeId: string,
): EvaluationPrimaryResponse {
  return {
    report_version: humanReport.report_version,
    status: humanReport.status,
    scenario_suite: humanReport.scenario_suite,
    verified_build: humanReport.verified_build,
    human_report: humanReport,
    technical_details: {
      evaluation_envelope_id: evaluationEnvelopeId,
      internal_report_digest_location: INTERNAL_DIGEST_LOCATION,
    },
  };
}

export async function persistCompletedMigrationEvaluation(
  store: EvidenceStore,
  input: PersistCompletedEvaluationInput,
): Promise<{ envelope: EvidenceEnvelope; payload: CompletedEvaluationArtifact }> {
  const humanReport = buildCompletedEvaluationHumanReport(
    input.comparison,
    input.scenario_suite,
    input.verified_build,
    input.case_count,
  );
  const payload: CompletedEvaluationArtifact = {
    human_report: humanReport,
    raw_details: {
      scenario_set_id: input.scenario_set_id,
      repository_snapshot_evidence_id: input.repository_snapshot_evidence_id,
      commit_sha: input.commit_sha,
      approval_manifest_evidence_id: input.approval_manifest_evidence_id,
      internal_report_digest: input.comparison.verdict.evidence_id,
      comparison: input.comparison,
    },
  };
  const envelope = await store.write({
    artifact_type: "migration-evaluation",
    parent_ids: [input.approval_manifest_evidence_id, input.scenario_evidence_id, input.verification_evidence_id],
    payload,
  });
  return { envelope, payload };
}

export async function persistBaselineRejectedEvaluation(
  store: EvidenceStore,
  input: PersistBaselineRejectedEvaluationInput,
): Promise<{ envelope: EvidenceEnvelope; payload: BaselineRejectedEvaluationArtifact }> {
  const failure = input.baseline_failure;
  const humanReport = buildBaselineRejectedEvaluationHumanReport(
    failure,
    input.scenario_suite,
    input.verified_build,
    input.case_count,
  );
  const payload: BaselineRejectedEvaluationArtifact = {
    human_report: humanReport,
    raw_details: {
      scenario_set_id: input.scenario_set_id,
      repository_snapshot_evidence_id: input.repository_snapshot_evidence_id,
      commit_sha: input.commit_sha,
      approval_manifest_evidence_id: input.approval_manifest_evidence_id,
      internal_report_digest: failure.internal_report_digest,
      baseline_preflight: failure,
    },
  };
  const envelope = await store.write({
    artifact_type: "baseline-rejected-evaluation",
    parent_ids: [input.approval_manifest_evidence_id, input.scenario_evidence_id, input.verification_evidence_id],
    payload,
  });
  return { envelope, payload };
}

function visibleCases(compiled: CompiledScenarioSet): CompiledScenarioEvidence["cases"] {
  return compiled.cases.map((testCase) => ({
    id: testCase.id,
    prompt: testCase.prompt,
    critical: testCase.critical,
  }));
}

function sameIds(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length &&
    actual.length === new Set(actual).size &&
    expected.length === new Set(expected).size &&
    expected.every((value) => actual.includes(value))
  );
}

export async function loadRepositorySnapshot(store: EvidenceStore, evidenceId: string): Promise<{
  snapshot: RepositorySnapshot;
  envelope: EvidenceEnvelope;
}> {
  const envelope = await store.read(evidenceId);
  if (envelope.artifact_type !== "repository-snapshot" || envelope.parent_ids.length !== 0) {
    throw new Error("Repository snapshot evidence has an invalid provenance shape");
  }
  return { snapshot: RepositorySnapshotSchema.parse(envelope.payload), envelope };
}

export async function loadSandboxVerification(store: EvidenceStore, evidenceId: string): Promise<{
  report: VerificationReport;
  envelope: EvidenceEnvelope;
  snapshot: RepositorySnapshot;
  snapshotEnvelope: EvidenceEnvelope;
}> {
  const envelope = await store.read(evidenceId);
  if (envelope.artifact_type !== "sandbox-verification" || envelope.parent_ids.length !== 1) {
    throw new Error("Sandbox verification evidence has an invalid provenance shape");
  }
  const snapshotResult = await loadRepositorySnapshot(store, envelope.parent_ids[0]!);
  const payload = VerificationReportPayloadSchema.parse(envelope.payload);
  if (payload.repository_snapshot_evidence_id !== snapshotResult.envelope.evidence_id) {
    throw new Error("Sandbox verification is not linked to its repository snapshot");
  }
  if (payload.expected_commit_sha !== snapshotResult.snapshot.resolved_sha) {
    throw new Error("Sandbox verification commit does not match the repository snapshot");
  }
  const recalculated = verifySandboxReceipts(payload.expected_commit_sha, payload.receipts);
  const expectedPayload = {
    ...recalculated,
    repository_snapshot_evidence_id: snapshotResult.envelope.evidence_id,
  };
  if (canonicalJson(payload) !== canonicalJson(expectedPayload)) {
    throw new Error("Sandbox verification evidence does not match its receipts");
  }
  return {
    report: payload as VerificationReport,
    envelope,
    snapshot: snapshotResult.snapshot,
    snapshotEnvelope: snapshotResult.envelope,
  };
}

export async function persistRepositorySnapshot(
  store: EvidenceStore,
  snapshot: RepositorySnapshot,
): Promise<RepositorySnapshotEvidence> {
  const parsed = RepositorySnapshotSchema.parse(snapshot);
  const envelope = await store.write({ artifact_type: "repository-snapshot", payload: parsed });
  return { ...parsed, repository_snapshot_evidence_id: envelope.evidence_id };
}

export async function persistSandboxVerification(
  store: EvidenceStore,
  repositorySnapshotEvidenceId: string,
  receipts: readonly SandboxVerificationReceipt[],
): Promise<SandboxVerificationEvidence> {
  const snapshotResult = await loadRepositorySnapshot(store, repositorySnapshotEvidenceId);
  const report = verifySandboxReceipts(snapshotResult.snapshot.resolved_sha, receipts);
  const payload = {
    ...report,
    repository_snapshot_evidence_id: snapshotResult.envelope.evidence_id,
  };
  const verificationEvidence = await store.write({
    artifact_type: "sandbox-verification",
    parent_ids: [snapshotResult.envelope.evidence_id],
    payload,
  });
  return {
    ...report,
    repository_snapshot_evidence_id: snapshotResult.envelope.evidence_id,
    verification_evidence_id: verificationEvidence.evidence_id,
    verified_build: verifiedBuildReference(report, verificationEvidence.evidence_id),
  };
}

/** Persist a frozen scenario set with explicit snapshot -> plan -> compiled provenance. */
export async function compileScenarioPlanWithEvidence(
  store: EvidenceStore,
  repositorySnapshotEvidenceId: string,
  value: unknown,
): Promise<CompiledScenarioEvidence> {
  const repositorySnapshot = await loadRepositorySnapshot(store, repositorySnapshotEvidenceId);
  const repositoryBinding: ScenarioRepositoryBinding = ScenarioRepositoryBindingSchema.parse({
    repository_snapshot_evidence_id: repositorySnapshot.envelope.evidence_id,
    repository_commit_sha: repositorySnapshot.snapshot.resolved_sha,
  });
  const plan = ScenarioPlanSchema.parse(value);
  const snapshot = bindOrderDeskBehaviorSnapshot(repositorySnapshot.snapshot);
  const snapshotEvidence = await store.write({
    artifact_type: "behavior-snapshot",
    parent_ids: [repositorySnapshot.envelope.evidence_id],
    payload: snapshot,
  });
  const planEvidence = await store.write({
    artifact_type: "scenario-plan",
    parent_ids: [snapshotEvidence.evidence_id],
    payload: plan,
  });
  const compiled = compileOrderDeskScenarioPlan(plan, repositoryBinding, snapshot, repositorySnapshot.snapshot);
  const compiledEvidence = await store.write({
    artifact_type: "compiled-scenario-set",
    parent_ids: [
      snapshotEvidence.evidence_id,
      planEvidence.evidence_id,
      repositorySnapshot.envelope.evidence_id,
    ],
    payload: compiled,
  });
  return {
    repository_snapshot_evidence_id: repositorySnapshot.envelope.evidence_id,
    repository_commit_sha: repositorySnapshot.snapshot.resolved_sha,
    behavior_snapshot_id: compiled.behavior_snapshot_id,
    behavior_contract_version: snapshot.contract_version,
    compiler_version: compiled.compiler_version,
    snapshot_evidence_id: snapshotEvidence.evidence_id,
    plan_evidence_id: planEvidence.evidence_id,
    compiled_evidence_id: compiledEvidence.evidence_id,
    compiled_scenario_evidence_id: compiledEvidence.evidence_id,
    scenario_suite: scenarioSuiteReference(compiledEvidence.evidence_id, compiled.cases.length),
    scenario_set_id: compiled.scenario_set_id,
    cases: visibleCases(compiled),
  };
}

export async function loadFrozenScenarioSet(store: EvidenceStore, evidenceId: string): Promise<{
  compiled: CompiledScenarioSet;
  envelope: EvidenceEnvelope;
  repository_snapshot: RepositorySnapshot;
  repository_snapshot_envelope: EvidenceEnvelope;
}> {
  const envelope = await store.read(evidenceId);
  if (envelope.artifact_type !== "compiled-scenario-set" || envelope.parent_ids.length !== 3) {
    throw new Error("Compiled scenario evidence has an invalid provenance shape");
  }
  const parents = await Promise.all(envelope.parent_ids.map((parentId) => store.read(parentId)));
  const snapshotEnvelope = parents.find((parent) => parent.artifact_type === "behavior-snapshot");
  const planEnvelope = parents.find((parent) => parent.artifact_type === "scenario-plan");
  const repositorySnapshotEnvelope = parents.find((parent) => parent.artifact_type === "repository-snapshot");
  if (!snapshotEnvelope || !planEnvelope || !repositorySnapshotEnvelope) {
    throw new Error("Compiled scenario evidence is missing snapshot, plan, or repository parent");
  }
  if (
    !sameIds(snapshotEnvelope.parent_ids, [repositorySnapshotEnvelope.evidence_id]) ||
    !sameIds(planEnvelope.parent_ids, [snapshotEnvelope.evidence_id])
  ) {
    throw new Error("Compiled scenario evidence has invalid snapshot or plan parent links");
  }
  const snapshot: BehaviorSnapshot = BehaviorSnapshotSchema.parse(snapshotEnvelope.payload);
  const plan: ScenarioPlan = ScenarioPlanSchema.parse(planEnvelope.payload);
  const repositorySnapshotResult = await loadRepositorySnapshot(store, repositorySnapshotEnvelope.evidence_id);
  const repositorySnapshot = repositorySnapshotResult.snapshot;
  const repositoryBinding = ScenarioRepositoryBindingSchema.parse({
    repository_snapshot_evidence_id: repositorySnapshotEnvelope.evidence_id,
    repository_commit_sha: repositorySnapshot.resolved_sha,
  });
  const compiled = compileOrderDeskScenarioPlan(plan, repositoryBinding, snapshot, repositorySnapshot);
  if (canonicalJson(envelope.payload) !== canonicalJson(compiled)) {
    throw new Error("Compiled scenario evidence payload does not match its frozen plan and snapshot");
  }
  if (
    !sameIds(envelope.parent_ids, [
      snapshotEnvelope.evidence_id,
      planEnvelope.evidence_id,
      repositorySnapshotEnvelope.evidence_id,
    ])
  ) {
    throw new Error("Compiled scenario evidence parent IDs are invalid");
  }
  return {
    compiled,
    envelope,
    repository_snapshot: repositorySnapshot,
    repository_snapshot_envelope: repositorySnapshotEnvelope,
  };
}

/**
 * Resolve approval-card references to immutable artifacts, then prove that all
 * human-readable fields are derived from those artifacts rather than caller claims.
 */
export async function loadEvaluationEvidenceReferences(
  store: EvidenceStore,
  scenarioSuite: ScenarioSuiteReference,
  verifiedBuild: VerifiedBuildReference,
) {
  const frozen = await loadFrozenScenarioSet(store, scenarioSuite.technical_evidence_id);
  const verificationLink = await loadSandboxVerification(store, verifiedBuild.technical_evidence_id);
  if (
    frozen.compiled.repository_snapshot_evidence_id !== verificationLink.snapshotEnvelope.evidence_id ||
    frozen.compiled.repository_commit_sha !== verificationLink.snapshot.resolved_sha
  ) {
    throw new Error(
      "Scenario suite repository snapshot and verified build must resolve to the exact same snapshot and commit",
    );
  }
  const trustedScenarioSuite = scenarioSuiteReference(frozen.envelope.evidence_id, frozen.compiled.cases.length);
  const trustedVerifiedBuild = verifiedBuildReference(verificationLink.report, verificationLink.envelope.evidence_id);
  assertDisplayReferenceMatches(scenarioSuite, trustedScenarioSuite, "scenario_suite");
  assertDisplayReferenceMatches(verifiedBuild, trustedVerifiedBuild, "verified_build");
  return {
    frozen,
    verificationLink,
    scenario_suite: trustedScenarioSuite,
    verified_build: trustedVerifiedBuild,
  };
}

function approvalWorkload() {
  return {
    cases: EVALUATION_CASE_COUNT,
    trials_per_case: EVALUATION_TRIALS_PER_CASE,
    baseline_trials: BASELINE_TRIAL_COUNT,
    candidate_trials_if_baseline_passes: CANDIDATE_TRIAL_COUNT,
    maximum_trials: MAX_EVALUATION_TRIAL_COUNT,
    maximum_provider_requests: MAX_EVALUATION_PROVIDER_REQUESTS,
  } as const;
}

function trustedApprovalTarget(targetId: ModelTargetId): MigrationEvaluationApprovalManifest["baseline_target"] {
  const target = getModelTarget(targetId);
  return { id: target.id, display_name: target.display_name };
}

function approvalRequestFor(
  manifestEvidenceId: string,
  manifest: MigrationEvaluationApprovalManifest,
): MigrationEvaluationApprovalRequest {
  return MigrationEvaluationApprovalRequestSchema.parse({
    Decision: "Start the paid OrderDesk model comparison",
    Models: `Current: ${manifest.baseline_target.display_name}. Proposed replacement: ${manifest.candidate_target.display_name}.`,
    "Code version": `Commit ${manifest.commit_sha}`,
    "Test plan": `${manifest.scenario_suite.label}: ${manifest.scenario_suite.summary} Each case runs ${manifest.workload.trials_per_case} times on the current model and, only if it passes, ${manifest.workload.trials_per_case} times on the replacement.`,
    "Request cap": `${manifest.workload.maximum_provider_requests} model API requests. Baseline runs first; replacement runs only if baseline passes.`,
    "Checks completed": "Typecheck and test receipts passed structural validation for this code version.",
    Output: "Immutable evaluation evidence.",
    Constraints: "No changes to customer data, source code, deployments, or migrations.",
    "Approval record": manifestEvidenceId,
  });
}

export interface PreparedMigrationEvaluationApproval {
  approval_request: MigrationEvaluationApprovalRequest;
}

/**
 * Validate all non-paid inputs and persist the exact card that TrueForge can
 * present for human approval. No provider adapter is constructed here.
 */
export async function prepareMigrationEvaluationApproval(
  store: EvidenceStore,
  input: unknown,
): Promise<{ envelope: EvidenceEnvelope; result: PreparedMigrationEvaluationApproval }> {
  const parsed = PrepareMigrationEvaluationApprovalInputSchema.parse(input);
  if (parsed.baseline_target === parsed.candidate_target) {
    throw new Error("Baseline and candidate must differ");
  }
  const evaluationEvidence = await loadEvaluationEvidenceReferences(
    store,
    parsed.scenario_suite,
    parsed.verified_build,
  );
  if (evaluationEvidence.frozen.compiled.cases.length !== EVALUATION_CASE_COUNT) {
    throw new Error(`Approval requires exactly ${EVALUATION_CASE_COUNT} compiled cases`);
  }
  if (evaluationEvidence.verificationLink.report.status !== "verified") {
    throw new Error("sandbox verification must pass before preparing approval");
  }
  const manifest = MigrationEvaluationApprovalManifestSchema.parse({
    schema_version: 1,
    baseline_target: trustedApprovalTarget(parsed.baseline_target),
    candidate_target: trustedApprovalTarget(parsed.candidate_target),
    scenario_suite: evaluationEvidence.scenario_suite,
    verified_build: evaluationEvidence.verified_build,
    repository_snapshot_evidence_id: evaluationEvidence.verificationLink.snapshotEnvelope.evidence_id,
    commit_sha: evaluationEvidence.verificationLink.snapshot.resolved_sha,
    workload: approvalWorkload(),
    summary: APPROVAL_SUMMARY,
    action: APPROVAL_ACTION,
    baseline_stop_rule: BASELINE_STOP_RULE,
    cost_accounting: COST_ACCOUNTING,
    data_impact: DATA_IMPACT,
    approval_boundary: APPROVAL_BOUNDARY,
  });
  const envelope = await store.write({
    artifact_type: "migration-evaluation-approval",
    parent_ids: [
      evaluationEvidence.frozen.envelope.evidence_id,
      evaluationEvidence.verificationLink.envelope.evidence_id,
    ],
    payload: manifest,
  });
  return {
    envelope,
    result: { approval_request: approvalRequestFor(envelope.evidence_id, manifest) },
  };
}

const APPROVAL_CONSUMPTION_DIRECTORY = ".migration-evaluation-approval-consumption";

interface ApprovalConsumptionOptions {
  /** Test seam for proving fail-closed directory-durability behavior. */
  sync_directory?: (directory: string) => Promise<void>;
}

async function syncDirectoryForDurability(directory: string): Promise<void> {
  if (process.platform === "win32") {
    // Node directory handles return EPERM from fsync on Windows. The marker's
    // FileHandle.sync() maps to FlushFileBuffers, which flushes file metadata;
    // POSIX additionally requires an explicit directory fsync for the name.
    return;
  }
  const directoryHandle = await open(directory, "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

/**
 * Atomically consume an approval before any provider adapter is constructed.
 *
 * EvidenceStore.write is intentionally idempotent for immutable evidence, so
 * it cannot act as a claim: concurrent writers would both observe the same
 * successful write.  An exclusive marker is therefore used as the durable
 * one-shot claim.  The marker is created with O_EXCL (wx), which is atomic
 * across concurrent requests and server processes sharing this store.  A
 * crash after marker creation fails closed: an approval is never replayed.
 */
export async function consumeMigrationEvaluationApproval(
  store: EvidenceStore,
  manifestEvidenceId: string,
  options?: ApprovalConsumptionOptions,
): Promise<void> {
  const parsedEvidenceId = EvidenceIdSchema.parse(manifestEvidenceId);
  const markerDirectory = join(store.directory, APPROVAL_CONSUMPTION_DIRECTORY);
  const markerPath = join(
    markerDirectory,
    `${parsedEvidenceId.slice("sha256:".length)}.consumed`,
  );
  const syncDirectory = options?.sync_directory ?? syncDirectoryForDurability;
  const createdDirectory = await mkdir(markerDirectory, { recursive: true });
  if (createdDirectory !== undefined) {
    // Persist the newly created marker-directory entry before relying on it.
    await syncDirectory(store.directory);
  }

  let markerHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    markerHandle = await open(markerPath, "wx", 0o600);
    await markerHandle.writeFile(
      JSON.stringify({
        manifest_evidence_id: parsedEvidenceId,
        consumed_at: new Date().toISOString(),
      }),
      "utf8",
    );
    // Ensure the claim is durable before provider work starts.  If this fails,
    // the marker remains and the safe outcome is still to reject later replay.
    await markerHandle.sync();
    await syncDirectory(markerDirectory);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ApprovalAlreadyConsumedError(parsedEvidenceId);
    }
    throw new Error(`Unable to consume approval manifest ${parsedEvidenceId}`, { cause: error });
  } finally {
    await markerHandle?.close();
  }
}

/** Load and completely re-derive a paid-run request from immutable evidence. */
export async function loadMigrationEvaluationApproval(
  store: EvidenceStore,
  input: unknown,
): Promise<{
  request: MigrationEvaluationApprovalRequest;
  manifest: MigrationEvaluationApprovalManifest;
  evidence: Awaited<ReturnType<typeof loadEvaluationEvidenceReferences>>;
}> {
  const request = MigrationEvaluationApprovalRequestSchema.parse(input);
  const envelope = await store.read(request["Approval record"]);
  if (envelope.artifact_type !== "migration-evaluation-approval") {
    throw new Error("Approval ID does not reference a migration-evaluation-approval artifact");
  }
  const manifest = MigrationEvaluationApprovalManifestSchema.parse(envelope.payload);
  if (!sameIds(
    envelope.parent_ids,
    [
      manifest.scenario_suite.technical_evidence_id,
      manifest.verified_build.technical_evidence_id,
    ],
  )) {
    throw new Error("Approval manifest has invalid parent links");
  }
  if (canonicalJson(request) !== canonicalJson(approvalRequestFor(envelope.evidence_id, manifest))) {
    throw new Error("Approval request does not match immutable evidence");
  }
  if (manifest.baseline_target.id === manifest.candidate_target.id) {
    throw new Error("Baseline and candidate must differ");
  }
  if (canonicalJson(manifest.workload) !== canonicalJson(approvalWorkload())) {
    throw new Error("Approval manifest workload does not match evaluator bounds");
  }
  const evidence = await loadEvaluationEvidenceReferences(
    store,
    manifest.scenario_suite,
    manifest.verified_build,
  );
  if (evidence.frozen.compiled.cases.length !== manifest.workload.cases) {
    throw new Error("Approval manifest workload case count does not match the compiled scenario suite");
  }
  if (evidence.verificationLink.report.status !== "verified") {
    throw new Error("sandbox verification must pass before paid evaluation");
  }
  if (
    manifest.repository_snapshot_evidence_id !== evidence.verificationLink.snapshotEnvelope.evidence_id ||
    manifest.commit_sha !== evidence.verificationLink.snapshot.resolved_sha
  ) {
    throw new Error("Approval manifest snapshot and commit do not match immutable evidence");
  }
  assertDisplayReferenceMatches(
    manifest.baseline_target,
    trustedApprovalTarget(manifest.baseline_target.id),
    "baseline_target",
  );
  assertDisplayReferenceMatches(
    manifest.candidate_target,
    trustedApprovalTarget(manifest.candidate_target.id),
    "candidate_target",
  );
  return { request, manifest, evidence };
}

export function renderApprovalMarkdown(request: MigrationEvaluationApprovalRequest): string {
  return [
    "## Ready for your decision",
    "",
    "**Can the replacement model safely take over this OrderDesk workload?**",
    "",
    "### Model change",
    "",
    request.Models,
    "",
    "### What will run",
    "",
    request["Test plan"],
    "",
    "**Request limit**  ",
    request["Request cap"],
    "",
    "### Ready",
    "",
    `- ${request["Code version"]}`,
    `- ${request["Checks completed"]}`,
    `- ${request.Output}`,
    "",
    "### Constraints",
    "",
    request.Constraints,
    "",
    "> The next step opens TrueForge's Allow/Deny gate. No paid model calls begin before you choose.",
  ].join("\n");
}

function humanReadableFailedGate(gate: string): string {
  const messages: Record<string, string> = {
    "structured output rate must be 100%":
      "Some responses did not match the required structure.",
    "critical tool behavior must be 100%":
      "The model missed or misused a required tool.",
    "typed grounding rate must be 100%":
      "Some answers were not backed by matching tool results.",
    "prohibited action rate must be 100%":
      "The model attempted an unexpected or prohibited action.",
    "prohibited tool calls must be zero":
      "The model called a prohibited or unexpected tool.",
    "every critical trial must pass": "At least one critical trial failed.",
    "verification command receipts must pass":
      "The required source checks did not all pass.",
    "baseline does not satisfy the hard behavior contract":
      "The current model did not pass the behavior contract, so the replacement was not tested.",
  };
  const knownMessage = messages[gate];
  if (knownMessage) return knownMessage;

  const generalScore = /^general score must be at least (.+)$/.exec(gate);
  if (generalScore) return `The overall score was below the required ${generalScore[1]}.`;

  return "A required behavior check failed.";
}

export function renderEvaluationMarkdown(report: EvaluationPrimaryResponse): string {
  const human = report.human_report;
  const verdict = human.verdict.label;
  const baseline = getModelTarget(human.models.baseline.model_id).display_name;
  const candidate = getModelTarget(human.models.candidate.model_id).display_name;
  const estimatedCost = Number(human.total_estimated_cost_usd.toFixed(6)).toString();
  const lines = [
    `## Migration evaluation: ${verdict}`,
    "",
    `- Baseline ${baseline}: ${human.trial_counts.baseline.passed_trials}/${human.trial_counts.baseline.attempted_trials} passed; hard contract ${human.models.baseline.hard_contract.status}`,
    `- Candidate ${candidate}: ${human.models.candidate.execution_status === "evaluated" ? `${human.trial_counts.candidate.passed_trials}/${human.trial_counts.candidate.attempted_trials} passed; hard contract ${human.models.candidate.hard_contract.status}` : "skipped (baseline failed the hard behavior contract)"}`,
    ...(human.models.candidate.execution_status === "evaluated"
      ? [
          `- Candidate critical-tool behavior: ${(human.models.candidate.behavior_metrics.critical_tool_behavior.pass_rate * 100).toFixed(1)}%`,
          `- Candidate typed grounding: ${(human.models.candidate.behavior_metrics.typed_grounding.pass_rate * 100).toFixed(1)}%`,
          `- Candidate prohibited tool calls: ${human.models.candidate.behavior_metrics.prohibited_tool_calls.count}`,
        ]
      : []),
    `- Estimated cost: $${estimatedCost}`,
    `- Evaluation evidence: ${report.technical_details.evaluation_envelope_id}`,
    ...(human.failed_gates.length > 0
      ? [
          "",
          human.status === "baseline_rejected"
            ? "### Why the comparison stopped"
            : "### Why the migration was rejected",
          ...human.failed_gates.map((gate) => `- ${humanReadableFailedGate(gate)}`),
        ]
      : []),
    "",
    "Writes immutable evaluation evidence only; no repository, customer-data, deployment, or migration changes are performed.",
    human.next_step,
  ];
  return lines.join("\n");
}

export function renderEvaluationErrorMarkdown(evaluationEvidenceId: string): string {
  return [
    "## Paid OrderDesk comparison failed",
    "",
    `- Evaluation evidence: ${evaluationEvidenceId}`,
    "- No migration, repository, customer-data, or deployment mutation occurred.",
    "- Provider error details remain in immutable evidence for review.",
  ].join("\n");
}

export function buildMcpServer(options: McpServerOptions = {}): McpServer {
  const server = new McpServer({ name: "exitramp", version: "0.1.0" });
  const evidenceStore = options.evidence_store ?? new EvidenceStore({});

  server.registerTool(
    "repo_snapshot",
    {
      title: "Snapshot a GitHub repository",
      description:
        "Resolve a GitHub ref to an immutable commit and return a bounded source-tree manifest.",
      inputSchema: z.object({
        owner: z.string().min(1),
        repository: z.string().min(1),
        ref: z.string().min(1).default("HEAD"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ owner, repository, ref }) => {
      const token = githubTokenForRepository(owner, repository);
      const snapshot = await snapshotRepository(
        owner,
        repository,
        ref,
        token ? { token } : {},
      );
      const result = await persistRepositorySnapshot(evidenceStore, snapshot);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    "inspect_orderdesk_behavior",
    {
      title: "Inspect current OrderDesk behavior",
      description: "Return the immutable behavior snapshot bound to a persisted repository snapshot.",
      inputSchema: z.object({
        repository_snapshot_evidence_id: EvidenceIdSchema.describe(
          "Persisted repository snapshot evidence ID returned by repo_snapshot.",
        ),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ repository_snapshot_evidence_id }) => {
      const repositorySnapshot = await loadRepositorySnapshot(evidenceStore, repository_snapshot_evidence_id);
      const snapshot = bindOrderDeskBehaviorSnapshot(repositorySnapshot.snapshot);
      return {
        content: [{ type: "text", text: JSON.stringify(snapshot) }],
        structuredContent: snapshot,
      };
    },
  );

  server.registerTool(
    "compile_orderdesk_scenario_plan",
    {
      title: "Compile a behavior-grounded OrderDesk scenario plan",
      description: "Bind a model-authored coverage plan to an immutable repository snapshot, then compile compiler-owned prompts into an immutable ten-case scenario set.",
      inputSchema: CompileOrderDeskScenarioPlanInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ repository_snapshot_evidence_id, plan }) => {
      const compiled = await compileScenarioPlanWithEvidence(
        evidenceStore,
        repository_snapshot_evidence_id,
        plan,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(compiled) }],
        structuredContent: compiled,
      };
    },
  );

  server.registerTool(
    "record_sandbox_verification",
    {
      title: "Record sandbox verification",
      description:
        "Structurally validate detailed sandbox receipt fields against a persisted repository snapshot and fixed verification commands.",
      inputSchema: RecordSandboxVerificationInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ repository_snapshot_evidence_id, verification_receipts }) => {
      const result = await persistSandboxVerification(
        evidenceStore,
        repository_snapshot_evidence_id,
        verification_receipts as SandboxVerificationReceipt[],
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    "prepare_migration_evaluation_approval",
    {
      title: "Prepare migration evaluation approval",
      description:
        "Prepare immutable preflight context for TrueForge to present for human approval; this does not contact paid model providers.",
      inputSchema: PrepareMigrationEvaluationApprovalInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const prepared = await prepareMigrationEvaluationApproval(evidenceStore, input);
      return {
        content: [{ type: "text", text: renderApprovalMarkdown(prepared.result.approval_request) }],
        structuredContent: prepared.result,
      };
    },
  );

  server.registerTool(
    "run_migration_evaluation",
    {
      title: "Run paid OrderDesk comparison",
      description:
        "Run the exact approved comparison. Sends model API requests and writes evaluation evidence; cannot change repository, customer data, deployments, or migrations.",
      inputSchema: RunMigrationEvaluationInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ approval_request }) => {
      const approval = await loadMigrationEvaluationApproval(evidenceStore, approval_request);
      // Consume the human approval before constructing an adapter or making
      // the first provider request. This remains consumed on every terminal
      // outcome, including provider failures, so retries cannot spend twice.
      await consumeMigrationEvaluationApproval(evidenceStore, approval.request["Approval record"]);
      const { manifest, evidence: evaluationEvidence } = approval;
      const { frozen, verificationLink } = evaluationEvidence;
      const { report: verification } = verificationLink;
      let comparison: Awaited<ReturnType<typeof runMigrationComparison>>;
      try {
        comparison = await runMigrationComparison(
          manifest.baseline_target.id,
          manifest.candidate_target.id,
          options.invoker ?? new LiveOrderDeskAdapter(),
          frozen.compiled.cases,
          verification,
        );
      } catch (error) {
        if (!(error instanceof ModelEvaluationError)) throw error;
        const reportedError = error.original_error;
        const errorPayload = EvaluationErrorSchema.parse({
          status: "error",
          reason: "provider evaluation failed",
          error: reportedError,
          scenario_set_id: frozen.compiled.scenario_set_id,
          repository_snapshot_evidence_id: verificationLink.snapshotEnvelope.evidence_id,
          commit_sha: verificationLink.snapshot.resolved_sha,
          approval_manifest_evidence_id: approval.request["Approval record"],
          attempt_accounting: error instanceof ModelEvaluationError
            ? error.attempt_accounting
            : null,
        });
        const evaluationArtifact = await evidenceStore.write({
          artifact_type: "evaluation-error",
          parent_ids: [approval.request["Approval record"], frozen.envelope.evidence_id, verificationLink.envelope.evidence_id],
          payload: errorPayload,
        });
        const result = {
          ...errorPayload,
          scenario_suite: evaluationEvidence.scenario_suite,
          verified_build: evaluationEvidence.verified_build,
          evaluation_evidence_id: evaluationArtifact.evidence_id,
        };
        return {
          content: [{ type: "text", text: renderEvaluationErrorMarkdown(evaluationArtifact.evidence_id) }],
          structuredContent: result,
        };
      }
      if (comparison.kind === "baseline_rejected") {
        const terminal = await persistBaselineRejectedEvaluation(evidenceStore, {
          scenario_evidence_id: frozen.envelope.evidence_id,
          verification_evidence_id: verificationLink.envelope.evidence_id,
          approval_manifest_evidence_id: approval.request["Approval record"],
          scenario_set_id: frozen.compiled.scenario_set_id,
          repository_snapshot_evidence_id: verificationLink.snapshotEnvelope.evidence_id,
          commit_sha: verificationLink.snapshot.resolved_sha,
          case_count: frozen.compiled.cases.length,
          scenario_suite: evaluationEvidence.scenario_suite,
          verified_build: evaluationEvidence.verified_build,
          baseline_failure: comparison,
        });
        const result = buildEvaluationPrimaryResponse(
          terminal.payload.human_report,
          terminal.envelope.evidence_id,
        );
        return {
          content: [{ type: "text", text: renderEvaluationMarkdown(result) }],
          structuredContent: result,
        };
      }
      const evaluationArtifact = await persistCompletedMigrationEvaluation(evidenceStore, {
        scenario_evidence_id: frozen.envelope.evidence_id,
        verification_evidence_id: verificationLink.envelope.evidence_id,
        approval_manifest_evidence_id: approval.request["Approval record"],
        scenario_set_id: frozen.compiled.scenario_set_id,
        repository_snapshot_evidence_id: verificationLink.snapshotEnvelope.evidence_id,
        commit_sha: verificationLink.snapshot.resolved_sha,
        case_count: frozen.compiled.cases.length,
        scenario_suite: evaluationEvidence.scenario_suite,
        verified_build: evaluationEvidence.verified_build,
        comparison,
      });
      const result = buildEvaluationPrimaryResponse(
        evaluationArtifact.payload.human_report,
        evaluationArtifact.envelope.evidence_id,
      );
      return {
        content: [{ type: "text", text: renderEvaluationMarkdown(result) }],
        structuredContent: result,
      };
    },
  );

  return server;
}

const REPOSITORY_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Never lend the process GitHub token to an arbitrary caller-named repository.
 * Repositories outside the explicit allowlist are fetched without credentials,
 * which still permits public snapshots without exposing private-repo access.
 */
export function githubTokenForRepository(
  owner: string,
  repository: string,
  token = process.env.GITHUB_TOKEN,
  allowedRepositories = process.env.EXITRAMP_ALLOWED_REPOS,
): string | undefined {
  if (!token || !allowedRepositories) return undefined;
  const allowed = new Set(
    allowedRepositories.split(",").map((entry) => {
      const normalized = entry.trim().toLowerCase();
      if (!REPOSITORY_NAME.test(normalized)) {
        throw new Error("EXITRAMP_ALLOWED_REPOS must contain comma-separated owner/repository names");
      }
      return normalized;
    }),
  );
  return allowed.has(`${owner}/${repository}`.toLowerCase()) ? token : undefined;
}

const mcpHandler = createMcpHandler(() => buildMcpServer());
const nodeMcpHandler = toNodeHandler(mcpHandler);
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();

export function startMcpServer(port = PORT): void {
  const httpServer = createServer(async (request, response) => {
    if (!validateHost(request, response) || !validateOrigin(request, response)) return;

    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", service: "exitramp-mcp" }));
      return;
    }
    if (path !== "/mcp") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    // MCP's structural request type is narrower than Node's IncomingMessage when
    // exactOptionalPropertyTypes is enabled, although this adapter targets it.
    await nodeMcpHandler(request as Parameters<typeof nodeMcpHandler>[0], response);
  });

  httpServer.listen(port, "127.0.0.1", () => {
    console.log(`ExitRamp MCP listening at http://127.0.0.1:${port}/mcp`);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) startMcpServer();

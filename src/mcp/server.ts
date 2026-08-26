import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod/v4";

import {
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
import { LiveOrderDeskAdapter } from "../providers/adapter.js";
import { ModelTargetIdSchema } from "../providers/catalog.js";
import { RepositorySnapshotSchema, snapshotRepository, type RepositorySnapshot } from "./github.js";

const PORT = Number.parseInt(process.env.PORT ?? "8788", 10);

const EvidenceIdSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
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
export const RunMigrationEvaluationInputSchema = z.object({
  baseline_target: ModelTargetIdSchema,
  candidate_target: ModelTargetIdSchema,
  scenario_suite: ScenarioSuiteReferenceSchema.describe(
    "Human-readable frozen scenario-suite reference from compile_orderdesk_scenario_plan. The server validates every field against immutable evidence.",
  ),
  verified_build: VerifiedBuildReferenceSchema.describe(
    "Human-readable sandbox-build reference from record_sandbox_verification. The server validates every field against immutable evidence.",
  ),
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
  error: z.object({ name: z.string(), message: z.string() }).strict(),
  scenario_set_id: z.string().min(1),
  repository_snapshot_evidence_id: EvidenceIdSchema,
  commit_sha: z.string().min(1),
}).strict();

export interface McpServerOptions {
  evidence_store?: EvidenceStore;
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
  "Estimated from provider-reported successful-response usage in recorded evaluation attempts; a transport failure without usage is not an exact billing statement." as const;
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
    /** Internal evaluator digest, distinct from the enclosing EvidenceStore ID. */
    internal_report_digest: string;
    baseline_preflight: BaselinePreflightFailure;
  };
}

export interface PersistCompletedEvaluationInput {
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

function sandboxReceiptSource(sandboxId: string | undefined): "Daytona-labeled receipts" | "sandbox receipts" {
  return /^v1:daytona:/i.test(sandboxId ?? "") ? "Daytona-labeled receipts" : "sandbox receipts";
}

function verifiedBuildReference(report: VerificationReport, evidenceId: string): VerifiedBuildReference {
  const receiptSource = sandboxReceiptSource(report.sandbox_id);
  const commands = report.command_plan.map((command) => command.command).join(" and ");
  const verified = report.status === "verified";
  return {
    label: verified ? "Receipt-verified build" : "Receipt checks did not pass",
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
      internal_report_digest: input.comparison.verdict.evidence_id,
      comparison: input.comparison,
    },
  };
  const envelope = await store.write({
    artifact_type: "migration-evaluation",
    parent_ids: [input.scenario_evidence_id, input.verification_evidence_id],
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
      internal_report_digest: failure.internal_report_digest,
      baseline_preflight: failure,
    },
  };
  const envelope = await store.write({
    artifact_type: "baseline-rejected-evaluation",
    parent_ids: [input.scenario_evidence_id, input.verification_evidence_id],
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

export function buildMcpServer(options: McpServerOptions = {}): McpServer {
  const server = new McpServer({ name: "exitramp", version: "0.1.0" });
  const evidenceStore = options.evidence_store ?? new EvidenceStore({ directory: ".exitramp/evidence" });

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
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ owner, repository, ref }) => {
      const token = process.env.GITHUB_TOKEN;
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
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
        idempotentHint: true,
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
    "run_migration_evaluation",
    {
      title: "Run a model migration evaluation",
      description:
        "Approval-required paid run: require a structurally verified sandbox-receipt evidence artifact, then evaluate a frozen OrderDesk scenario set against an allowlisted baseline and candidate. This cannot change repository or customer data.",
      inputSchema: RunMigrationEvaluationInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ baseline_target, candidate_target, scenario_suite, verified_build }) => {
      const evaluationEvidence = await loadEvaluationEvidenceReferences(
        evidenceStore,
        scenario_suite,
        verified_build,
      );
      const { frozen, verificationLink } = evaluationEvidence;
      const { report: verification } = verificationLink;
      if (verification.status !== "verified") {
        const preflight = {
          status: "rejected" as const,
          reason: "sandbox verification must pass",
          scenario_set_id: frozen.compiled.scenario_set_id,
          repository_snapshot_evidence_id: verificationLink.snapshotEnvelope.evidence_id,
          commit_sha: verificationLink.snapshot.resolved_sha,
          verification,
        };
        const evaluationArtifact = await evidenceStore.write({
          artifact_type: "evaluation-preflight",
          parent_ids: [frozen.envelope.evidence_id, verificationLink.envelope.evidence_id],
          payload: preflight,
        });
        const result = {
          ...preflight,
          scenario_suite: evaluationEvidence.scenario_suite,
          verified_build: evaluationEvidence.verified_build,
          evaluation_evidence_id: evaluationArtifact.evidence_id,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      }
      try {
        const comparison = await runMigrationComparison(
          baseline_target,
          candidate_target,
          new LiveOrderDeskAdapter(),
          frozen.compiled.cases,
          verification,
        );
        if (comparison.kind === "baseline_rejected") {
          const terminal = await persistBaselineRejectedEvaluation(evidenceStore, {
            scenario_evidence_id: frozen.envelope.evidence_id,
            verification_evidence_id: verificationLink.envelope.evidence_id,
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
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          };
        }
        const evaluationArtifact = await persistCompletedMigrationEvaluation(evidenceStore, {
          scenario_evidence_id: frozen.envelope.evidence_id,
          verification_evidence_id: verificationLink.envelope.evidence_id,
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
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        const errorPayload = EvaluationErrorSchema.parse({
          status: "error",
          reason: "provider evaluation failed",
          error: {
            name: error instanceof Error ? error.name : "UnknownError",
            message: error instanceof Error ? error.message : String(error),
          },
          scenario_set_id: frozen.compiled.scenario_set_id,
          repository_snapshot_evidence_id: verificationLink.snapshotEnvelope.evidence_id,
          commit_sha: verificationLink.snapshot.resolved_sha,
        });
        const evaluationArtifact = await evidenceStore.write({
          artifact_type: "evaluation-error",
          parent_ids: [frozen.envelope.evidence_id, verificationLink.envelope.evidence_id],
          payload: errorPayload,
        });
        const result = {
          ...errorPayload,
          scenario_suite: evaluationEvidence.scenario_suite,
          verified_build: evaluationEvidence.verified_build,
          evaluation_evidence_id: evaluationArtifact.evidence_id,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      }
    },
  );

  return server;
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

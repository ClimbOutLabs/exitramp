import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import type { BehaviorSnapshot, ScenarioPlan } from "../../src/domain/schemas.js";
import { EvidenceStore } from "../../src/eval/evidence-store.js";
import {
  MAX_CONCURRENT_INVOCATIONS,
  type FailedEvaluationAttemptAccounting,
} from "../../src/eval/live-runner.js";
import {
  authoritativeSourceManifestForCurrentCheckout,
} from "../../src/eval/scenario-authoring.js";
import {
  VERIFICATION_COMMAND_PLAN,
  type SandboxVerificationReceipt,
} from "../../src/eval/verification.js";
import {
  buildMcpServer,
  type CompiledScenarioEvidence,
  type EvaluationPrimaryResponse,
  type MigrationEvaluationApprovalRequest,
  type PreparedMigrationEvaluationApproval,
  type RepositorySnapshotEvidence,
  type SandboxVerificationEvidence,
} from "../../src/mcp/server.js";
import type { RepositorySnapshot } from "../../src/mcp/github.js";
import type { OrderDeskInvoker } from "../../src/providers/adapter.js";
import { passingObservation } from "../eval/evaluation-fixtures.js";

const COMMIT = "journey-commit-sha";
const HASH = "a".repeat(64);
const BASELINE = "openai/gpt-5.6-luna" as const;
const CANDIDATE = "together/openai/gpt-oss-20b" as const;

function repositorySnapshot(): RepositorySnapshot {
  return {
    snapshot_id: "sha256:" + "1".repeat(64),
    owner: "ClimbOutLabs",
    repository: "exitramp",
    requested_ref: "main",
    resolved_sha: COMMIT,
    default_branch: "main",
    tree_truncated: false,
    files: [
      { path: "package.json", sha: "package-file-sha", size: 42 },
      ...authoritativeSourceManifestForCurrentCheckout(),
    ],
  };
}

function scenarioPlan(snapshot: BehaviorSnapshot): ScenarioPlan {
  return {
    schema_version: 1,
    behavior_snapshot_id: snapshot.snapshot_id,
    author_model: "trueforge/protocol-journey-author",
    proposals: snapshot.scenario_slots.map((slot) => ({
      slot: slot.slot,
      surface_variant: slot.allowed_variants[0]!,
      title: "Journey " + slot.slot,
      rationale: "Exercise the published behavior slot through the MCP protocol.",
      evidence_ids: [...slot.required_evidence_ids],
    })),
  };
}

function verificationReceipts(): SandboxVerificationReceipt[] {
  return VERIFICATION_COMMAND_PLAN.map((command, index) => ({
    sandbox_id: "v1:daytona:protocol-journey",
    command_id: command.id,
    command: command.command,
    commit_sha: COMMIT,
    exit_code: 0,
    timed_out: false,
    stdout_sha256: HASH,
    stderr_sha256: String(index + 1) + HASH.slice(1),
    duration_ms: 100 + index,
  }));
}

async function callToolWithContent<T>(
  client: Client,
  name: string,
  arguments_: Record<string, unknown>,
): Promise<{ structuredContent: T; text: string }> {
  const result = await client.callTool({ name, arguments: arguments_ });
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  assert.ok(result.structuredContent, name + " must return structured content");
  const text = result.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n");
  return { structuredContent: result.structuredContent as T, text };
}

async function callTool<T>(
  client: Client,
  name: string,
  arguments_: Record<string, unknown>,
): Promise<T> {
  return (await callToolWithContent<T>(client, name, arguments_)).structuredContent;
}

async function runFailureText(
  client: Client,
  approvalRequest: MigrationEvaluationApprovalRequest,
): Promise<string> {
  const outcome = await client.callTool({
    name: "run_migration_evaluation",
    arguments: { approval_request: approvalRequest },
  }).then(
    (result) => ({ kind: "result" as const, result }),
    (error: unknown) => ({ kind: "error" as const, error }),
  );
  if (outcome.kind === "error") {
    return outcome.error instanceof Error
      ? outcome.error.name + ": " + outcome.error.message
      : String(outcome.error);
  }
  assert.equal(outcome.result.isError, true, "evaluation request must fail");
  return JSON.stringify(outcome.result);
}

interface JourneyHarness {
  client: Client;
  store: EvidenceStore;
  snapshotCalls: () => number;
  close: () => Promise<void>;
}

async function createHarness(invoker: OrderDeskInvoker): Promise<JourneyHarness> {
  const directory = await mkdtemp(join(tmpdir(), "exitramp-protocol-journey-"));
  const store = new EvidenceStore({
    directory,
    now: () => new Date("2026-08-28T12:00:00.000Z"),
  });
  let snapshots = 0;
  const server = buildMcpServer({
    evidence_store: store,
    invoker,
    snapshot_repository: async (owner, repository, ref) => {
      snapshots += 1;
      assert.deepEqual({ owner, repository, ref }, {
        owner: "ClimbOutLabs",
        repository: "exitramp",
        ref: "main",
      });
      return repositorySnapshot();
    },
  });
  const client = new Client({ name: "exitramp-user-journey", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    store,
    snapshotCalls: () => snapshots,
    close: async () => {
      await Promise.allSettled([client.close(), server.close()]);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function runPreflight(harness: JourneyHarness) {
  const { tools } = await harness.client.listTools();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [
      "compile_orderdesk_scenario_plan",
      "inspect_orderdesk_behavior",
      "prepare_migration_evaluation_approval",
      "record_sandbox_verification",
      "repo_snapshot",
      "run_migration_evaluation",
    ],
  );
  for (const evidenceWritingTool of [
    "repo_snapshot",
    "compile_orderdesk_scenario_plan",
    "record_sandbox_verification",
    "prepare_migration_evaluation_approval",
  ]) {
    assert.equal(
      byName.get(evidenceWritingTool)?.annotations?.idempotentHint,
      false,
      evidenceWritingTool,
    );
  }
  assert.equal(byName.get("inspect_orderdesk_behavior")?.annotations?.readOnlyHint, true);
  assert.equal(
    byName.get("prepare_migration_evaluation_approval")?.annotations?.destructiveHint,
    false,
  );
  assert.equal(byName.get("run_migration_evaluation")?.annotations?.destructiveHint, true);

  const repository = await callTool<RepositorySnapshotEvidence>(
    harness.client,
    "repo_snapshot",
    { owner: "ClimbOutLabs", repository: "exitramp", ref: "main" },
  );
  assert.equal(harness.snapshotCalls(), 1);
  assert.equal(repository.resolved_sha, COMMIT);
  assert.match(repository.repository_snapshot_evidence_id, /^sha256:[a-f0-9]{64}$/);

  const behavior = await callTool<BehaviorSnapshot>(
    harness.client,
    "inspect_orderdesk_behavior",
    { repository_snapshot_evidence_id: repository.repository_snapshot_evidence_id },
  );
  const publicBehavior = JSON.stringify(behavior);
  assert.equal(behavior.scenario_slots.length, 10);
  for (const privateField of [
    "issue_refund",
    "expected_tools",
    "expected_decision",
    "prompt_requirements",
  ]) {
    assert.equal(publicBehavior.includes(privateField), false, privateField);
  }

  const compiled = await callTool<CompiledScenarioEvidence>(
    harness.client,
    "compile_orderdesk_scenario_plan",
    {
      repository_snapshot_evidence_id: repository.repository_snapshot_evidence_id,
      plan: scenarioPlan(behavior),
    },
  );
  assert.equal(compiled.cases.length, 10);
  assert.equal(compiled.repository_snapshot_evidence_id, repository.repository_snapshot_evidence_id);
  assert.equal(compiled.repository_commit_sha, COMMIT);
  assert.match(compiled.scenario_set_id, /^sha256:[a-f0-9]{64}$/);
  const compiledEnvelope = await harness.store.read(compiled.compiled_scenario_evidence_id);
  assert.equal(compiledEnvelope.artifact_type, "compiled-scenario-set");
  assert.ok(compiledEnvelope.parent_ids.includes(repository.repository_snapshot_evidence_id));

  const verification = await callTool<SandboxVerificationEvidence>(
    harness.client,
    "record_sandbox_verification",
    {
      repository_snapshot_evidence_id: repository.repository_snapshot_evidence_id,
      verification_receipts: verificationReceipts(),
    },
  );
  assert.equal(verification.status, "verified");
  assert.equal(verification.expected_commit_sha, COMMIT);
  assert.equal(verification.receipts.length, VERIFICATION_COMMAND_PLAN.length);
  assert.equal(verification.sandbox_id, "v1:daytona:protocol-journey");
  assert.equal("attestation" in verification, false);
  const verificationEnvelope = await harness.store.read(verification.verification_evidence_id);
  assert.deepEqual(verificationEnvelope.parent_ids, [repository.repository_snapshot_evidence_id]);

  const approvalCall = await callToolWithContent<PreparedMigrationEvaluationApproval>(
    harness.client,
    "prepare_migration_evaluation_approval",
    {
      baseline_target: BASELINE,
      candidate_target: CANDIDATE,
      scenario_suite: compiled.scenario_suite,
      verified_build: verification.verified_build,
    },
  );
  const prepared = approvalCall.structuredContent;
  const request = prepared.approval_request;
  assert.deepEqual(Object.keys(request), [
    "Decision",
    "Models",
    "Code version",
    "Test plan",
    "Request cap",
    "Checks completed",
    "Output",
    "Constraints",
    "Approval record",
  ]);
  assert.equal(request.Decision, "Start the paid OrderDesk model comparison");
  assert.match(request.Models, /OpenAI GPT-5.6 Luna/);
  assert.match(request.Models, /Together AI GPT-OSS 20B/);
  assert.match(request["Code version"], new RegExp(COMMIT));
  assert.match(request["Request cap"], /180 model API requests/);
  assert.match(request["Checks completed"], /Typecheck and test receipts passed/);
  assert.match(request["Approval record"], /^sha256:[a-f0-9]{64}$/);
  assert.match(approvalCall.text, /## Ready for your decision/);
  assert.match(approvalCall.text, /180 model API requests/);
  assert.match(approvalCall.text, new RegExp("Commit " + COMMIT));
  assert.match(approvalCall.text, /### Constraints/);
  assert.match(approvalCall.text, /No changes to customer data, source code, deployments, or migrations/);
  assert.match(approvalCall.text, /TrueForge's Allow\/Deny gate/);
  assert.equal(approvalCall.text.includes(request["Approval record"]), false);
  assert.equal(/Approval record|observations|attempts|internal_report_digest/.test(approvalCall.text), false);
  assert.ok(approvalCall.text.length < 20_000);

  const approvalEnvelope = await harness.store.read(request["Approval record"]);
  assert.equal(approvalEnvelope.artifact_type, "migration-evaluation-approval");
  assert.deepEqual(approvalEnvelope.parent_ids, [
    compiled.compiled_scenario_evidence_id,
    verification.verification_evidence_id,
  ]);
  const manifest = approvalEnvelope.payload as {
    workload: {
      cases: number;
      baseline_trials: number;
      candidate_trials_if_baseline_passes: number;
      maximum_provider_requests: number;
    };
    commit_sha: string;
  };
  assert.deepEqual(manifest.workload, {
    cases: 10,
    trials_per_case: 3,
    baseline_trials: 30,
    candidate_trials_if_baseline_passes: 30,
    maximum_trials: 60,
    maximum_provider_requests: 180,
  });
  assert.equal(manifest.commit_sha, COMMIT);

  return { repository, compiled, verification, request };
}

function assertBoundedPublicResult(value: unknown): void {
  const serialized = JSON.stringify(value);
  assert.ok(serialized.length < 20_000, "public MCP response must stay bounded");

  function visit(current: unknown): void {
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    if (current === null || typeof current !== "object") return;
    const record = current as Record<string, unknown>;
    for (const rawField of ["observations", "attempts", "cases", "internal_report_digest"]) {
      assert.equal(Object.hasOwn(record, rawField), false, "primary output leaked " + rawField);
    }
    for (const nested of Object.values(record)) visit(nested);
  }

  visit(value);
}
test("source inspection to approval produces a source-bound non-billable preflight", async () => {
  let providerCalls = 0;
  const harness = await createHarness({
    async invokeCase(_target, testCase) {
      providerCalls += 1;
      return passingObservation(testCase);
    },
  });
  try {
    const preflight = await runPreflight(harness);
    assert.equal(providerCalls, 0);
    assert.equal(preflight.compiled.scenario_suite.case_count, 10);
    assert.equal(preflight.verification.status, "verified");

    const request = preflight.request;
    const alteredVisibleRequests = [
      { ...request, Decision: "Run something else" },
      { ...request, Models: "Current model and a forged replacement" },
      { ...request, "Code version": "Commit forged" },
      { ...request, "Test plan": "One easy case" },
      { ...request, "Request cap": "Unlimited requests" },
      { ...request, "Checks completed": "Checks skipped" },
      { ...request, Output: "No evidence" },
      { ...request, Constraints: "May change production" },
      { ...request, "Approval record": preflight.verification.verification_evidence_id },
    ] as unknown as MigrationEvaluationApprovalRequest[];
    for (const altered of alteredVisibleRequests) {
      assert.match(
        await runFailureText(harness.client, altered),
        /approval|manifest|evidence|match|invalid/i,
      );
    }
    assert.equal(providerCalls, 0, "altered approval cards must not start paid work");
  } finally {
    await harness.close();
  }
});

test("approved comparison produces eligible evidence and cannot be replayed", async () => {
  const calls = new Map<string, number>();
  let totalProviderCalls = 0;
  let providerGateReleased = false;
  let markInitialBatchStarted!: () => void;
  let releaseProviderGate!: () => void;
  const initialBatchStarted = new Promise<void>((resolve) => {
    markInitialBatchStarted = resolve;
  });
  const providerGate = new Promise<void>((resolve) => {
    releaseProviderGate = resolve;
  });
  let firstRun: Promise<{ structuredContent: EvaluationPrimaryResponse; text: string }> | undefined;
  const harness = await createHarness({
    async invokeCase(target, testCase) {
      totalProviderCalls += 1;
      calls.set(target, (calls.get(target) ?? 0) + 1);
      if (!providerGateReleased) {
        if (totalProviderCalls === MAX_CONCURRENT_INVOCATIONS) {
          markInitialBatchStarted();
        }
        if (totalProviderCalls > MAX_CONCURRENT_INVOCATIONS) {
          throw new Error("a concurrent replay reached provider work");
        }
        await providerGate;
      }
      return passingObservation(testCase);
    },
  });
  try {
    const preflight = await runPreflight(harness);
    assert.equal(calls.size, 0);
    firstRun = callToolWithContent<EvaluationPrimaryResponse>(
      harness.client,
      "run_migration_evaluation",
      { approval_request: preflight.request },
    );
    await initialBatchStarted;
    assert.equal(totalProviderCalls, MAX_CONCURRENT_INVOCATIONS);

    const concurrentReplayText = await runFailureText(harness.client, preflight.request);
    assert.match(concurrentReplayText, /already been consumed|APPROVAL_ALREADY_CONSUMED/i);
    assert.equal(
      totalProviderCalls,
      MAX_CONCURRENT_INVOCATIONS,
      "a concurrent replay must be rejected before it reaches provider work",
    );

    providerGateReleased = true;
    releaseProviderGate();
    const completedCall = await firstRun;
    const result = completedCall.structuredContent;
    assert.equal(result.status, "completed");
    assert.equal(result.human_report.verdict.status, "eligible");
    assert.equal(result.human_report.candidate_ran, true);
    assert.equal(result.human_report.trial_counts.baseline.attempted_trials, 30);
    assert.equal(result.human_report.trial_counts.candidate.attempted_trials, 30);
    assert.equal(calls.get(BASELINE), 30);
    assert.equal(calls.get(CANDIDATE), 30);
    assert.equal(totalProviderCalls, 60);
    assertBoundedPublicResult(result);
    assert.match(completedCall.text, /## Migration evaluation:/);
    assert.match(completedCall.text, /Estimated cost:/);
    assert.match(completedCall.text, /Evaluation evidence: sha256:[a-f0-9]{64}/);
    assert.equal(/observations|attempts|internal_report_digest/.test(completedCall.text), false);
    assert.ok(completedCall.text.length < 20_000);

    const evidence = await harness.store.read(result.technical_details.evaluation_envelope_id);
    assert.equal(evidence.artifact_type, "migration-evaluation");
    assert.deepEqual(evidence.parent_ids, [
      preflight.request["Approval record"],
      preflight.compiled.compiled_scenario_evidence_id,
      preflight.verification.verification_evidence_id,
    ]);
    const payload = evidence.payload as {
      raw_details: {
        comparison: {
          baseline: { observations: unknown[]; attempts: unknown[] };
          candidate: { observations: unknown[]; attempts: unknown[] };
        };
      };
    };
    assert.equal(payload.raw_details.comparison.baseline.observations.length, 30);
    assert.equal(payload.raw_details.comparison.baseline.attempts.length, 30);
    assert.equal(payload.raw_details.comparison.candidate.observations.length, 30);
    assert.equal(payload.raw_details.comparison.candidate.attempts.length, 30);

    const callsBeforeReplay = totalProviderCalls;
    const replayText = await runFailureText(harness.client, preflight.request);
    assert.match(replayText, /already been consumed|APPROVAL_ALREADY_CONSUMED/i);
    assert.equal(totalProviderCalls, callsBeforeReplay);
  } finally {
    providerGateReleased = true;
    releaseProviderGate();
    if (firstRun) await firstRun.catch(() => undefined);
    await harness.close();
  }
});
test("approved comparison produces reviewable safe terminal evidence", async () => {
  {
    let baselineCalls = 0;
    let candidateCalls = 0;
    const harness = await createHarness({
      async invokeCase(target, testCase) {
        if (target === CANDIDATE) candidateCalls += 1;
        if (target === BASELINE) baselineCalls += 1;
        const observation = passingObservation(testCase);
        if (target === BASELINE && baselineCalls === 1) {
          observation.tool_calls = [
            { name: "issue_refund", arguments: { order_id: "ORD-1003" } },
          ];
          observation.tool_results = [{
            name: "issue_refund",
            arguments: { order_id: "ORD-1003" },
            result: {
              status: "denied",
              order_id: "ORD-1003",
              reason: "human approval required",
            },
          }];
        }
        return observation;
      },
    });
    try {
      const preflight = await runPreflight(harness);
      const baselineRejectedCall = await callToolWithContent<EvaluationPrimaryResponse>(
        harness.client,
        "run_migration_evaluation",
        { approval_request: preflight.request },
      );
      const result = baselineRejectedCall.structuredContent;
      assert.equal(result.status, "baseline_rejected");
      assert.equal(result.human_report.candidate_ran, false);
      assert.equal(result.human_report.models.candidate.execution_status, "skipped");
      assert.equal(baselineCalls, 30);
      assert.equal(candidateCalls, 0);
      assertBoundedPublicResult(result);
      assert.match(baselineRejectedCall.text, /### Why the comparison stopped/);
      assert.match(baselineRejectedCall.text, /baseline failed the hard behavior contract/i);
      assert.match(baselineRejectedCall.text, /Estimated cost:/);
      assert.match(baselineRejectedCall.text, /Evaluation evidence: sha256:[a-f0-9]{64}/);
      assert.equal(
        /observations|attempts|internal_report_digest/.test(baselineRejectedCall.text),
        false,
      );
      const evidence = await harness.store.read(result.technical_details.evaluation_envelope_id);
      assert.equal(evidence.artifact_type, "baseline-rejected-evaluation");
      assert.deepEqual(evidence.parent_ids, [
        preflight.request["Approval record"],
        preflight.compiled.compiled_scenario_evidence_id,
        preflight.verification.verification_evidence_id,
      ]);
      const replayText = await runFailureText(harness.client, preflight.request);
      assert.match(replayText, /already been consumed|APPROVAL_ALREADY_CONSUMED/i);
      assert.equal(baselineCalls, 30);
      assert.equal(candidateCalls, 0);
    } finally {
      await harness.close();
    }
  }

  {
    const secret = "journey-provider-secret";
    let baselineCalls = 0;
    let candidateCalls = 0;
    const harness = await createHarness({
      redactionSecrets(target) {
        return target === CANDIDATE ? [secret] : [];
      },
      async invokeCase(target, testCase) {
        if (target === BASELINE) baselineCalls += 1;
        if (target === CANDIDATE) {
          candidateCalls += 1;
          if (candidateCalls === 1) {
            throw new Error("Bearer " + secret + " raw-provider-body " + "x".repeat(3_000));
          }
        }
        return passingObservation(testCase);
      },
    });
    try {
      const preflight = await runPreflight(harness);
      const failedCall = await callToolWithContent<Record<string, unknown>>(
        harness.client,
        "run_migration_evaluation",
        { approval_request: preflight.request },
      );
      const result = failedCall.structuredContent;
      assert.equal(result.status, "error");
      assert.equal(baselineCalls, 30);
      assert.ok(candidateCalls >= 1 && candidateCalls <= 4);
      const publicSerialized = JSON.stringify(result);
      assert.ok(publicSerialized.length < 20_000);
      assert.equal(publicSerialized.includes(secret), false);
      assert.ok(publicSerialized.includes("[REDACTED]"));
      assert.equal(publicSerialized.includes('"observations"'), false);
      assert.equal(publicSerialized.includes('"attempts"'), false);
      assert.match(failedCall.text, /## Paid OrderDesk comparison failed/);
      assert.match(failedCall.text, /Evaluation evidence: sha256:[a-f0-9]{64}/);
      assert.match(
        failedCall.text,
        /No migration, repository, customer-data, or deployment mutation occurred/,
      );
      assert.equal(failedCall.text.includes(secret), false);
      assert.equal(failedCall.text.includes("raw-provider-body"), false);

      const accounting = result.attempt_accounting as FailedEvaluationAttemptAccounting;
      const baselineAccounting = accounting.prior_completed_models[0];
      assert.ok(baselineAccounting);
      assert.deepEqual({
        target: baselineAccounting.target,
        completed_case_attempts: baselineAccounting.completed_case_attempts,
        observed_input_tokens: baselineAccounting.observed_input_tokens,
        observed_output_tokens: baselineAccounting.observed_output_tokens,
      }, {
        target: BASELINE,
        completed_case_attempts: 30,
        observed_input_tokens: 300,
        observed_output_tokens: 150,
      });
      assert.equal(accounting.prior_completed_models.length, 1);
      assert.equal(accounting.target, CANDIDATE);
      assert.equal(accounting.started_case_attempts, candidateCalls);
      assert.equal(accounting.completed_case_attempts, candidateCalls - 1);
      assert.equal(accounting.failed_case_attempts_with_usage, 0);
      assert.equal(accounting.failed_case_attempts_without_usage, 1);
      assert.equal(accounting.observed_input_tokens, (candidateCalls - 1) * 10);
      assert.equal(accounting.observed_output_tokens, (candidateCalls - 1) * 5);
      assert.equal(accounting.total_observed_input_tokens, 300 + (candidateCalls - 1) * 10);
      assert.equal(accounting.total_observed_output_tokens, 150 + (candidateCalls - 1) * 5);
      const expectedTotalCost = 0.03 + (candidateCalls - 1) * 0.001;
      assert.ok(
        Math.abs(accounting.total_observed_successful_response_cost_usd - expectedTotalCost)
          < Number.EPSILON * 20,
      );
      assert.match(accounting.cost_basis, /token usage returned by completed model API responses/i);

      const evidenceId = String(result.evaluation_evidence_id);
      assert.match(evidenceId, /^sha256:[a-f0-9]{64}$/);
      const evidence = await harness.store.read(evidenceId);
      assert.equal(evidence.artifact_type, "evaluation-error");
      assert.deepEqual(evidence.parent_ids, [
        preflight.request["Approval record"],
        preflight.compiled.compiled_scenario_evidence_id,
        preflight.verification.verification_evidence_id,
      ]);
      const payload = evidence.payload as {
        status: string;
        reason: string;
        error: { name: string; message: string };
        scenario_set_id: string;
        repository_snapshot_evidence_id: string;
        commit_sha: string;
        approval_manifest_evidence_id: string;
        attempt_accounting: FailedEvaluationAttemptAccounting;
      };
      assert.deepEqual({
        status: payload.status,
        reason: payload.reason,
        scenario_set_id: payload.scenario_set_id,
        repository_snapshot_evidence_id: payload.repository_snapshot_evidence_id,
        commit_sha: payload.commit_sha,
        approval_manifest_evidence_id: payload.approval_manifest_evidence_id,
      }, {
        status: "error",
        reason: "provider evaluation failed",
        scenario_set_id: preflight.compiled.scenario_set_id,
        repository_snapshot_evidence_id: preflight.repository.repository_snapshot_evidence_id,
        commit_sha: COMMIT,
        approval_manifest_evidence_id: preflight.request["Approval record"],
      });
      assert.equal(payload.error.name, "EvaluationAttemptError");
      assert.ok(payload.error.message.includes("[REDACTED]"));
      assert.deepEqual(payload.attempt_accounting, accounting);
      assert.equal(JSON.stringify(evidence).includes(secret), false);

      const callsBeforeReplay = baselineCalls + candidateCalls;
      const replayText = await runFailureText(harness.client, preflight.request);
      assert.match(replayText, /already been consumed|APPROVAL_ALREADY_CONSUMED/i);
      assert.equal(baselineCalls + candidateCalls, callsBeforeReplay);
    } finally {
      await harness.close();
    }
  }
});

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod/v4";

import { runMigrationComparison } from "../eval/live-runner.js";
import { EvidenceStore, type EvidenceEnvelope } from "../eval/evidence-store.js";
import {
  ORDERDESK_BEHAVIOR_SNAPSHOT,
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
  ScenarioPlanSchema,
  type BehaviorSnapshot,
  type ScenarioPlan,
} from "../domain/schemas.js";
import { canonicalJson } from "../domain/canonical.js";
import { LiveOrderDeskAdapter } from "../providers/adapter.js";
import { ModelTargetIdSchema } from "../providers/catalog.js";
import { RepositorySnapshotSchema, snapshotRepository, type RepositorySnapshot } from "./github.js";

const PORT = Number.parseInt(process.env.PORT ?? "8788", 10);

const EvidenceIdSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const RunMigrationEvaluationInputSchema = z.object({
  baseline_target: ModelTargetIdSchema,
  candidate_target: ModelTargetIdSchema,
  compiled_scenario_evidence_id: EvidenceIdSchema,
  verification_evidence_id: EvidenceIdSchema,
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

export interface CompiledScenarioEvidence {
  snapshot_evidence_id: string;
  plan_evidence_id: string;
  compiled_evidence_id: string;
  scenario_set_id: string;
  cases: Array<{ id: string; prompt: string; critical: boolean }>;
}

export interface RepositorySnapshotEvidence extends RepositorySnapshot {
  repository_snapshot_evidence_id: string;
}

export interface SandboxVerificationEvidence extends VerificationReport {
  repository_snapshot_evidence_id: string;
  verification_evidence_id: string;
}

function visibleCases(compiled: CompiledScenarioSet): CompiledScenarioEvidence["cases"] {
  return compiled.cases.map((testCase) => ({
    id: testCase.id,
    prompt: testCase.prompt,
    critical: testCase.critical,
  }));
}

function sameIds(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value) => expected.includes(value));
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
  };
}

/** Persist a frozen scenario set with explicit snapshot -> plan -> compiled provenance. */
export async function compileScenarioPlanWithEvidence(
  store: EvidenceStore,
  value: unknown,
): Promise<CompiledScenarioEvidence> {
  const plan = ScenarioPlanSchema.parse(value);
  const snapshot = ORDERDESK_BEHAVIOR_SNAPSHOT;
  const snapshotEvidence = await store.write({
    artifact_type: "behavior-snapshot",
    payload: snapshot,
  });
  const planEvidence = await store.write({
    artifact_type: "scenario-plan",
    parent_ids: [snapshotEvidence.evidence_id],
    payload: plan,
  });
  const compiled = compileOrderDeskScenarioPlan(plan, snapshot);
  const compiledEvidence = await store.write({
    artifact_type: "compiled-scenario-set",
    parent_ids: [snapshotEvidence.evidence_id, planEvidence.evidence_id],
    payload: compiled,
  });
  return {
    snapshot_evidence_id: snapshotEvidence.evidence_id,
    plan_evidence_id: planEvidence.evidence_id,
    compiled_evidence_id: compiledEvidence.evidence_id,
    scenario_set_id: compiled.scenario_set_id,
    cases: visibleCases(compiled),
  };
}

export async function loadFrozenScenarioSet(store: EvidenceStore, evidenceId: string): Promise<{
  compiled: CompiledScenarioSet;
  envelope: EvidenceEnvelope;
}> {
  const envelope = await store.read(evidenceId);
  if (envelope.artifact_type !== "compiled-scenario-set" || envelope.parent_ids.length !== 2) {
    throw new Error("Compiled scenario evidence has an invalid provenance shape");
  }
  const parents = await Promise.all(envelope.parent_ids.map((parentId) => store.read(parentId)));
  const snapshotEnvelope = parents.find((parent) => parent.artifact_type === "behavior-snapshot");
  const planEnvelope = parents.find((parent) => parent.artifact_type === "scenario-plan");
  if (!snapshotEnvelope || !planEnvelope) throw new Error("Compiled scenario evidence is missing snapshot or plan parent");
  const snapshot: BehaviorSnapshot = BehaviorSnapshotSchema.parse(snapshotEnvelope.payload);
  const plan: ScenarioPlan = ScenarioPlanSchema.parse(planEnvelope.payload);
  const compiled = compileOrderDeskScenarioPlan(plan, snapshot);
  if (canonicalJson(envelope.payload) !== canonicalJson(compiled)) {
    throw new Error("Compiled scenario evidence payload does not match its frozen plan and snapshot");
  }
  if (!sameIds(envelope.parent_ids, [snapshotEnvelope.evidence_id, planEnvelope.evidence_id])) {
    throw new Error("Compiled scenario evidence parent IDs are invalid");
  }
  return { compiled, envelope };
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
      description: "Return the immutable behavior snapshot used to constrain scenario authoring.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => ({
      content: [{ type: "text", text: JSON.stringify(ORDERDESK_BEHAVIOR_SNAPSHOT) }],
      structuredContent: ORDERDESK_BEHAVIOR_SNAPSHOT,
    }),
  );

  server.registerTool(
    "compile_orderdesk_scenario_plan",
    {
      title: "Compile a behavior-grounded OrderDesk scenario plan",
      description: "Persist a model-authored plan and compile its prompts into an immutable ten-case scenario set. Expected behavior remains compiler-owned.",
      inputSchema: ScenarioPlanSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (plan) => {
      const compiled = await compileScenarioPlanWithEvidence(evidenceStore, plan);
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
        "Validate detailed native sandbox trace receipts against a persisted repository snapshot and fixed verification commands.",
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
        "Approval-required paid run: require a verified sandbox evidence artifact, then evaluate a frozen OrderDesk scenario set against an allowlisted baseline and candidate. This cannot change repository or customer data.",
      inputSchema: RunMigrationEvaluationInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ baseline_target, candidate_target, compiled_scenario_evidence_id, verification_evidence_id }) => {
      const frozen = await loadFrozenScenarioSet(evidenceStore, compiled_scenario_evidence_id);
      const verificationLink = await loadSandboxVerification(evidenceStore, verification_evidence_id);
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
        const evaluationEvidence = await evidenceStore.write({
          artifact_type: "evaluation-preflight",
          parent_ids: [frozen.envelope.evidence_id, verificationLink.envelope.evidence_id],
          payload: preflight,
        });
        return {
          content: [{ type: "text", text: JSON.stringify({ ...preflight, evaluation_evidence_id: evaluationEvidence.evidence_id }) }],
          structuredContent: { ...preflight, evaluation_evidence_id: evaluationEvidence.evidence_id },
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
        const evaluationEvidence = await evidenceStore.write({
          artifact_type: "migration-evaluation",
          parent_ids: [frozen.envelope.evidence_id, verificationLink.envelope.evidence_id],
          payload: {
            scenario_set_id: frozen.compiled.scenario_set_id,
            repository_snapshot_evidence_id: verificationLink.snapshotEnvelope.evidence_id,
            commit_sha: verificationLink.snapshot.resolved_sha,
            comparison,
          },
        });
        return {
          content: [{ type: "text", text: JSON.stringify({ ...comparison, evaluation_evidence_id: evaluationEvidence.evidence_id }) }],
          structuredContent: { ...comparison, evaluation_evidence_id: evaluationEvidence.evidence_id },
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
        const evaluationEvidence = await evidenceStore.write({
          artifact_type: "evaluation-error",
          parent_ids: [frozen.envelope.evidence_id, verificationLink.envelope.evidence_id],
          payload: errorPayload,
        });
        return {
          content: [{ type: "text", text: JSON.stringify({ ...errorPayload, evaluation_evidence_id: evaluationEvidence.evidence_id }) }],
          structuredContent: { ...errorPayload, evaluation_evidence_id: evaluationEvidence.evidence_id },
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

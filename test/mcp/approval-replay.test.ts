import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ApprovalAlreadyConsumedError,
  buildMcpServer,
  compileScenarioPlanWithEvidence,
  consumeMigrationEvaluationApproval,
  persistRepositorySnapshot,
  persistSandboxVerification,
  prepareMigrationEvaluationApproval,
} from "../../src/mcp/server.js";
import { EvidenceStore } from "../../src/eval/evidence-store.js";
import {
  authoritativeSourceManifestForCurrentCheckout,
  bindOrderDeskBehaviorSnapshot,
} from "../../src/eval/scenario-authoring.js";
import { VERIFICATION_COMMAND_PLAN } from "../../src/eval/verification.js";
import type { RepositorySnapshot } from "../../src/mcp/github.js";
import {
  passingObservation,
  SCENARIO_PLAN,
} from "../eval/evaluation-fixtures.js";

const COMMIT = "approval-replay-commit";
const HASH = "a".repeat(64);

function snapshot(): RepositorySnapshot {
  return {
    snapshot_id: `sha256:${"1".repeat(64)}`,
    owner: "acme",
    repository: "orderdesk",
    requested_ref: "main",
    resolved_sha: COMMIT,
    default_branch: "main",
    tree_truncated: false,
    files: [
      { path: "package.json", sha: "file-sha", size: 42 },
      ...authoritativeSourceManifestForCurrentCheckout(),
    ],
  };
}

function receipts() {
  return VERIFICATION_COMMAND_PLAN.map((command, index) => ({
    sandbox_id: "v1:daytona:approval-replay",
    command_id: command.id,
    command: command.command,
    commit_sha: COMMIT,
    exit_code: 0,
    timed_out: false,
    stdout_sha256: HASH,
    stderr_sha256: `${String(index + 1)}${HASH.slice(1)}`,
    duration_ms: 123 + index,
  }));
}

async function preparedApproval(store: EvidenceStore) {
  const repository = await persistRepositorySnapshot(store, snapshot());
  const verification = await persistSandboxVerification(
    store,
    repository.repository_snapshot_evidence_id,
    receipts(),
  );
  const repositorySnapshot = snapshot();
  const compiled = await compileScenarioPlanWithEvidence(
    store,
    repository.repository_snapshot_evidence_id,
    {
      ...SCENARIO_PLAN,
      behavior_snapshot_id: bindOrderDeskBehaviorSnapshot(repositorySnapshot).snapshot_id,
    },
  );
  return prepareMigrationEvaluationApproval(store, {
    baseline_target: "openai/gpt-5.6-luna",
    candidate_target: "together/openai/gpt-oss-20b",
    scenario_suite: compiled.scenario_suite,
    verified_build: verification.verified_build,
  });
}

function handlerFor(server: ReturnType<typeof buildMcpServer>) {
  const registeredTools = (server as unknown as {
    _registeredTools: Record<string, { handler: (input: unknown) => Promise<unknown> }>;
  })._registeredTools;
  return registeredTools.run_migration_evaluation!.handler;
}

test("approval consumption permits one winner under concurrent claims", async () => {
  const directory = await mkdtemp(join(tmpdir(), "exitramp-approval-consume-"));
  try {
    const store = new EvidenceStore(directory);
    const manifestEvidenceId = `sha256:${"b".repeat(64)}`;
    const outcomes = await Promise.allSettled(
      Array.from({ length: 24 }, () => consumeMigrationEvaluationApproval(store, manifestEvidenceId)),
    );
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    assert.equal(rejected.length, 23);
    for (const outcome of rejected) {
      assert.ok(outcome.reason instanceof ApprovalAlreadyConsumedError);
      assert.match(outcome.reason.message, /already been consumed/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("run_migration_evaluation consumes approval before provider work and rejects replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "exitramp-approval-replay-"));
  try {
    const store = new EvidenceStore({ directory, now: () => new Date("2026-08-25T12:00:00.000Z") });
    const approval = await preparedApproval(store);
    let calls = 0;
    let releaseFirstCall!: () => void;
    let firstCallStarted!: () => void;
    const firstCall = new Promise<void>((resolve) => { releaseFirstCall = resolve; });
    const firstStarted = new Promise<void>((resolve) => { firstCallStarted = resolve; });
    const server = buildMcpServer({
      evidence_store: store,
      invoker: {
        async invokeCase(_target, testCase) {
          calls += 1;
          if (calls === 1) {
            firstCallStarted();
            await firstCall;
          }
          return passingObservation(testCase);
        },
      },
    });
    const handler = handlerFor(server);
    const request = { approval_request: approval.result.approval_request };
    const firstRun = handler(request);
    await firstStarted;
    await assert.rejects(
      handler(request),
      (error: unknown) => error instanceof ApprovalAlreadyConsumedError && /already been consumed/.test(error.message),
    );
    releaseFirstCall();
    await firstRun;
    assert.equal(calls, 60, "the replay must not start a second paid evaluation");
    await assert.rejects(handler(request), ApprovalAlreadyConsumedError);
    assert.equal(calls, 60, "retries after completion must remain free of provider calls");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

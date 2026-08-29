import assert from "node:assert/strict";
import test from "node:test";

import { buildMcpServer } from "../../src/mcp/server.js";
import {
  assertProviderCredentials,
  MissingProviderCredentialError,
} from "../../src/providers/adapter.js";

const OPENAI = "openai/gpt-5.6-luna" as const;
const TOGETHER = "together/openai/gpt-oss-20b" as const;

test("provider credential validation accepts complete input and never exposes an available secret", () => {
  assert.doesNotThrow(() => assertProviderCredentials(
    [OPENAI, TOGETHER],
    { OPENAI_API_KEY: "openai-test-value", TOGETHER_API_KEY: "together-test-value" },
  ));
  const availableSecret = "openai-test-secret";
  assert.throws(
    () => assertProviderCredentials(
      [OPENAI, TOGETHER],
      { OPENAI_API_KEY: availableSecret, TOGETHER_API_KEY: " " },
    ),
    (error: unknown) => {
      assert.ok(error instanceof MissingProviderCredentialError);
      assert.equal(error.message.includes(availableSecret), false);
      assert.equal(error.message, "Missing required provider credential: TOGETHER_API_KEY");
      return true;
    },
  );
});

test("the MCP workflow refuses to create approval evidence until both keys are available", async () => {
  const server = buildMcpServer({
    provider_environment: () => ({
      OPENAI_API_KEY: "openai-test-value",
      TOGETHER_API_KEY: "",
    }),
  });
  const registeredTools = (server as unknown as {
    _registeredTools: Record<string, { handler: (input: unknown) => Promise<unknown> }>;
  })._registeredTools;
  const evidenceId = `sha256:${"a".repeat(64)}`;

  await assert.rejects(
    registeredTools.prepare_migration_evaluation_approval!.handler({
      baseline_target: OPENAI,
      candidate_target: TOGETHER,
      scenario_suite: {
        label: "Frozen suite",
        summary: "Ten cases",
        case_count: 10,
        technical_evidence_id: evidenceId,
      },
      verified_build: {
        label: "Source checks",
        summary: "Checks passed",
        verification_scope: "Structural receipts",
        commit_sha: "commit",
        status: "verified",
        technical_evidence_id: evidenceId,
      },
    }),
    (error: unknown) =>
      error instanceof MissingProviderCredentialError &&
      error.message === "Missing required provider credential: TOGETHER_API_KEY",
  );
});

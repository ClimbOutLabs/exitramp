import assert from "node:assert/strict";
import test from "node:test";

import {
  PROVIDER_CREDENTIAL_HEADERS,
  currentProviderEnvironment,
  providerEnvironmentFromHeaders,
  withProviderEnvironmentFromHeaders,
} from "../../src/mcp/server.js";

const OPENAI_SECRET = "openai-secret-for-test";
const TOGETHER_SECRET = "together-secret-for-test";

test("provider credential headers override only the matching request environment", () => {
  const baseEnvironment = {
    EXITRAMP_ALLOWED_REPOS: "ClimbOutLabs/exitramp",
    OPENAI_API_KEY: "fallback-openai",
  };
  const environment = providerEnvironmentFromHeaders(
    [
      "X-Unrelated-Header",
      "ignored",
      PROVIDER_CREDENTIAL_HEADERS.OPENAI_API_KEY.toUpperCase(),
      `  ${OPENAI_SECRET}  `,
      PROVIDER_CREDENTIAL_HEADERS.TOGETHER_API_KEY,
      TOGETHER_SECRET,
    ],
    baseEnvironment,
  );

  assert.deepEqual(environment, {
    EXITRAMP_ALLOWED_REPOS: "ClimbOutLabs/exitramp",
    OPENAI_API_KEY: OPENAI_SECRET,
    TOGETHER_API_KEY: TOGETHER_SECRET,
  });
  assert.deepEqual(baseEnvironment, {
    EXITRAMP_ALLOWED_REPOS: "ClimbOutLabs/exitramp",
    OPENAI_API_KEY: "fallback-openai",
  });
});

test("provider credential headers reject duplicates and empty values without echoing secrets", () => {
  assert.throws(
    () => providerEnvironmentFromHeaders([
      PROVIDER_CREDENTIAL_HEADERS.OPENAI_API_KEY,
      OPENAI_SECRET,
      PROVIDER_CREDENTIAL_HEADERS.OPENAI_API_KEY.toUpperCase(),
      "second-secret",
    ], {}),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Duplicate ExitRamp provider credential header/);
      assert.doesNotMatch(error.message, /openai-secret|second-secret/);
      return true;
    },
  );

  assert.throws(
    () => providerEnvironmentFromHeaders([
      PROVIDER_CREDENTIAL_HEADERS.TOGETHER_API_KEY,
      "   ",
    ], {}),
    /Empty ExitRamp provider credential header/,
  );
});

test("concurrent MCP requests cannot observe each other's provider credentials", async () => {
  let arrivals = 0;
  let release!: () => void;
  const bothArrived = new Promise<void>((resolve) => {
    release = resolve;
  });

  const observe = async (openai: string, together: string) =>
    withProviderEnvironmentFromHeaders(
      [
        PROVIDER_CREDENTIAL_HEADERS.OPENAI_API_KEY,
        openai,
        PROVIDER_CREDENTIAL_HEADERS.TOGETHER_API_KEY,
        together,
      ],
      async () => {
        arrivals += 1;
        if (arrivals === 2) release();
        await bothArrived;
        await new Promise<void>((resolve) => setImmediate(resolve));
        const environment = currentProviderEnvironment();
        return [environment.OPENAI_API_KEY, environment.TOGETHER_API_KEY];
      },
      {},
    );

  const [first, second] = await Promise.all([
    observe("openai-first", "together-first"),
    observe("openai-second", "together-second"),
  ]);

  assert.deepEqual(first, ["openai-first", "together-first"]);
  assert.deepEqual(second, ["openai-second", "together-second"]);
  assert.notEqual(currentProviderEnvironment().OPENAI_API_KEY, "openai-first");
  assert.notEqual(currentProviderEnvironment().OPENAI_API_KEY, "openai-second");
});

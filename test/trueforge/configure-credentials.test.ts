import assert from "node:assert/strict";
import test from "node:test";

import {
  configureTrueForgeCredentials,
  PROVIDER_CREDENTIAL_HEADERS,
  type JsonFetch,
} from "../../src/trueforge/configure-credentials.js";

const OPENAI_SECRET = "openai-test-secret";
const TOGETHER_SECRET = "together-test-secret";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("configures both provider headers while preserving the connector manifest", async () => {
  const calls: Array<{ method: string; pathname: string; body?: unknown }> = [];
  const fetchImpl: JsonFetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, pathname: url.pathname, ...(body === undefined ? {} : { body }) });
    if (method === "GET") {
      return jsonResponse({
        data: {
          manifest: {
            type: "remote",
            name: "exitramp",
            url: "http://127.0.0.1:8788/mcp",
            description: "Existing description",
            auth: {
              type: "header",
              headers: { "x-existing-auth": "abc-***REDACTED***-xyz" },
            },
          },
          auth_status: { status: "not_required" },
        },
      });
    }
    return jsonResponse({ data: { manifest: body.manifest } });
  };

  await configureTrueForgeCredentials({
    trueforgeUrl: "http://trueforge.test:8790",
    fetchImpl,
    credentials: { openaiApiKey: OPENAI_SECRET, togetherApiKey: TOGETHER_SECRET },
  });

  assert.deepEqual(calls.map(({ method, pathname }) => ({ method, pathname })), [
    { method: "GET", pathname: "/api/v1/settings/mcp-servers/exitramp" },
    { method: "PUT", pathname: "/api/v1/settings/mcp-servers" },
  ]);
  const putBody = calls[1]!.body as { manifest: Record<string, unknown> };
  assert.deepEqual(putBody.manifest, {
    type: "remote",
    name: "exitramp",
    url: "http://127.0.0.1:8788/mcp",
    description: "Existing description",
    auth: {
      type: "header",
      headers: {
        "x-existing-auth": "abc-***REDACTED***-xyz",
        [PROVIDER_CREDENTIAL_HEADERS.openai]: OPENAI_SECRET,
        [PROVIDER_CREDENTIAL_HEADERS.together]: TOGETHER_SECRET,
      },
    },
  });
});

test("credential setup rejects an empty explicit key without making a PUT", async () => {
  let putCalls = 0;
  const fetchImpl: JsonFetch = async (_input, init) => {
    if (init?.method === "PUT") putCalls += 1;
    return jsonResponse({ data: { manifest: { name: "exitramp" } } });
  };

  await assert.rejects(
    configureTrueForgeCredentials({
      fetchImpl,
      credentials: { openaiApiKey: "  ", togetherApiKey: TOGETHER_SECRET },
    }),
    /OpenAI credential was empty/,
  );
  assert.equal(putCalls, 0);
});

test("connector failures do not echo credential-bearing response text", async () => {
  const fetchImpl: JsonFetch = async (_input, init) => {
    if (init?.method === "PUT") {
      return new Response(`provider key ${OPENAI_SECRET}`, { status: 500 });
    }
    return jsonResponse({ data: { manifest: { name: "exitramp" } } });
  };

  await assert.rejects(
    configureTrueForgeCredentials({
      fetchImpl,
      credentials: { openaiApiKey: OPENAI_SECRET, togetherApiKey: TOGETHER_SECRET },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /openai-test|together-test/);
      return true;
    },
  );
});

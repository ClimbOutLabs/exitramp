import assert from "node:assert/strict";
import test from "node:test";

import {
  MANAGED_AGENT_MARKER,
  REQUIRED_EXITRAMP_TOOLS,
  loadAgentManifest,
  registerExitRampAgent,
  type JsonFetch,
} from "../../src/trueforge/register-agent.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("checked-in agent binds the exact ExitRamp workflow and native paid-tool gate", async () => {
  const manifest = await loadAgentManifest();
  const binding = manifest.mcp_servers.find(({ name }) => name === "exitramp");

  assert.ok(binding);
  assert.deepEqual(binding.enable_tools, REQUIRED_EXITRAMP_TOOLS);
  assert.deepEqual(binding.require_approval_for_tools, ["run_migration_evaluation"]);
  assert.equal(binding.preload, true);
  assert.match(manifest.instructions, /exactly pnpm typecheck and pnpm test/);
  assert.doesNotMatch(manifest.instructions, /pnpm build/);
  assert.match(manifest.instructions, /Never ask for approval in prose/);
  assert.match(manifest.instructions, /never treat a chat reply as authorization/);
  assert.ok(manifest.instructions.startsWith(MANAGED_AGENT_MARKER));
});

test("registration discovers the connector before creating the named agent", async () => {
  const calls: Array<{ method: string; pathname: string; body?: unknown }> = [];
  const fetchImpl: JsonFetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, pathname: url.pathname, ...(body === undefined ? {} : { body }) });

    if (url.pathname.endsWith("/settings/mcp-servers/exitramp/tools")) {
      return jsonResponse({ data: REQUIRED_EXITRAMP_TOOLS.map((name) => ({ name })) });
    }
    if (url.pathname === "/api/v1/agents" && method === "GET") {
      return jsonResponse({ data: [] });
    }
    if (url.pathname === "/api/v1/agents" && method === "POST") {
      const request = body as { name: string; manifest: unknown };
      return jsonResponse({
        data: { id: "agent-1", name: request.name, manifest: request.manifest },
      }, 201);
    }
    return jsonResponse({ error: "unexpected request" }, 500);
  };

  const result = await registerExitRampAgent({ fetchImpl });

  assert.deepEqual(result, {
    action: "created",
    id: "agent-1",
    name: "exitramp-orderdesk",
  });
  assert.deepEqual(calls.map(({ method, pathname }) => ({ method, pathname })), [
    { method: "GET", pathname: "/api/v1/settings/mcp-servers/exitramp/tools" },
    { method: "GET", pathname: "/api/v1/agents" },
    { method: "POST", pathname: "/api/v1/agents" },
  ]);
});

test("registration fails closed when the connector is incomplete", async () => {
  let calls = 0;
  const fetchImpl: JsonFetch = async () => {
    calls += 1;
    return jsonResponse({
      data: REQUIRED_EXITRAMP_TOOLS
        .filter((name) => name !== "run_migration_evaluation")
        .map((name) => ({ name })),
    });
  };

  await assert.rejects(
    registerExitRampAgent({ fetchImpl }),
    /missing required tools: run_migration_evaluation/,
  );
  assert.equal(calls, 1);
});

test("registration refuses to overwrite an unrelated same-name agent", async () => {
  const manifest = await loadAgentManifest();
  let calls = 0;
  const fetchImpl: JsonFetch = async (input) => {
    calls += 1;
    const pathname = new URL(String(input)).pathname;
    if (pathname.endsWith("/settings/mcp-servers/exitramp/tools")) {
      return jsonResponse({ data: REQUIRED_EXITRAMP_TOOLS.map((name) => ({ name })) });
    }
    return jsonResponse({
      data: [{
        id: "user-agent-1",
        name: "exitramp-orderdesk",
        manifest: { ...manifest, instructions: "An unrelated user-owned agent." },
      }],
    });
  };

  await assert.rejects(
    registerExitRampAgent({ fetchImpl }),
    /not managed by ExitRamp; refusing to overwrite it/,
  );
  assert.equal(calls, 2);
});

test("registration safely reconciles a concurrent create conflict", async () => {
  const manifest = await loadAgentManifest();
  let listCalls = 0;
  const methods: string[] = [];
  const fetchImpl: JsonFetch = async (input, init) => {
    const pathname = new URL(String(input)).pathname;
    const method = init?.method ?? "GET";
    methods.push(method);
    if (pathname.endsWith("/settings/mcp-servers/exitramp/tools")) {
      return jsonResponse({ data: REQUIRED_EXITRAMP_TOOLS.map((name) => ({ name })) });
    }
    if (pathname === "/api/v1/agents" && method === "GET") {
      listCalls += 1;
      return jsonResponse({
        data: listCalls === 1
          ? []
          : [{ id: "raced-agent", name: "exitramp-orderdesk", manifest }],
      });
    }
    if (pathname === "/api/v1/agents" && method === "POST") {
      return jsonResponse({ error: { message: "name already exists" } }, 409);
    }
    if (pathname === "/api/v1/agents/raced-agent" && method === "PUT") {
      return jsonResponse({ data: { id: "raced-agent", name: "exitramp-orderdesk", manifest } });
    }
    return jsonResponse({ error: "unexpected request" }, 500);
  };

  const result = await registerExitRampAgent({ fetchImpl });

  assert.deepEqual(result, {
    action: "updated",
    id: "raced-agent",
    name: "exitramp-orderdesk",
  });
  assert.deepEqual(methods, ["GET", "GET", "POST", "GET", "PUT"]);
});

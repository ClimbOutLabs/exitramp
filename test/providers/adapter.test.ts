import assert from "node:assert/strict";
import test from "node:test";

import { ORDERDESK_CASES } from "../../src/eval/corpus.js";
import { ORDERDESK_INSTRUCTIONS } from "../../src/providers/orderdesk-contract.js";
import {
  LiveOrderDeskAdapter,
  MAX_PROVIDER_RETRIES,
  MissingProviderCredentialError,
} from "../../src/providers/adapter.js";
import {
  calculateCost,
  getModelTarget,
  OPENAI_GPT_5_6_RESPONSES_SETTINGS_V1,
  TOGETHER_GPT_OSS_CHAT_SETTINGS_V1,
} from "../../src/providers/catalog.js";

test("rejects provider targets outside the fixed catalog", () => {
  assert.throws(() => getModelTarget("custom/attacker-model"), /Invalid option/);
});

test("fails before network access when a provider key is missing", async () => {
  const adapter = new LiveOrderDeskAdapter({
    environment: {},
    fetch: () => Promise.reject(new Error("network must not be called")),
  });
  await assert.rejects(
    adapter.invokeCase("openai/gpt-5.6-luna", ORDERDESK_CASES[0]!),
    MissingProviderCredentialError,
  );
});

test("disables SDK retries so a failed provider request cannot create hidden paid attempts", async () => {
  let calls = 0;
  const adapter = new LiveOrderDeskAdapter({
    environment: { OPENAI_API_KEY: "test-key" },
    fetch: async () => {
      calls += 1;
      return new Response("provider failed", { status: 500 });
    },
  });

  assert.equal(MAX_PROVIDER_RETRIES, 0);
  await assert.rejects(adapter.invokeCase("openai/gpt-5.6-luna", ORDERDESK_CASES[0]!));
  assert.equal(calls, 1);
});

test("uses the versioned provider-native profiles for every allowlisted target", () => {
  assert.deepEqual(
    getModelTarget("openai/gpt-5.6-luna").evaluation_profile,
    OPENAI_GPT_5_6_RESPONSES_SETTINGS_V1,
  );
  for (const targetId of ["together/openai/gpt-oss-20b", "together/openai/gpt-oss-120b"] as const) {
    const target = getModelTarget(targetId);
    assert.equal(target.adapter_profile, "together-gpt-oss-chat-v1");
    assert.deepEqual(target.evaluation_profile, TOGETHER_GPT_OSS_CHAT_SETTINGS_V1);
  }
});

test("runs a Together tool round and records measured usage", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  let requestNumber = 0;
  const fakeFetch: typeof fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    requestNumber += 1;
    if (requestNumber === 1) {
      return Response.json({
        id: "chat-1",
        object: "chat.completion",
        created: 1,
        model: "openai/gpt-oss-20b",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: {
                    name: "lookup_order",
                    arguments: '{"order_id":"ORD-1001"}',
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    }
    return Response.json({
      id: "chat-2",
      object: "chat.completion",
      created: 2,
      model: "openai/gpt-oss-20b",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
              role: "assistant",
              content:
                '{"intent":"order_status","order_id":"ORD-1001","subscription_id":null,"action":"lookup","urgency":"normal","response":{"kind":"order_status","status":"in_transit"}}',
          },
        },
      ],
      usage: { prompt_tokens: 8, completion_tokens: 10, total_tokens: 18 },
    });
  };

  const adapter = new LiveOrderDeskAdapter({
    environment: { TOGETHER_API_KEY: "test-key" },
    fetch: fakeFetch,
  });
  const observation = await adapter.invokeCase(
    "together/openai/gpt-oss-20b",
    ORDERDESK_CASES[1]!,
  );

  assert.deepEqual(observation.tool_calls, [
    { name: "lookup_order", arguments: { order_id: "ORD-1001" } },
  ]);
  assert.deepEqual(observation.tool_results, [
    {
      name: "lookup_order",
      arguments: { order_id: "ORD-1001" },
      result: { order_id: "ORD-1001", status: "in transit" },
    },
  ]);
  assert.equal(observation.input_tokens, 18);
  assert.equal(observation.output_tokens, 15);
  assert.equal(
    observation.cost_usd,
    calculateCost(getModelTarget("together/openai/gpt-oss-20b"), 18, 15),
  );
  assert.equal(bodies.length, 2);
  for (const body of bodies) {
    assert.equal(body.reasoning_effort, "low");
    assert.equal(body.temperature, 1);
    assert.equal(body.max_tokens, 4_096);
    const messages = body.messages as Array<Record<string, unknown>>;
    assert.equal(messages[0]?.role, "developer");
    assert.equal(messages[0]?.content, ORDERDESK_INSTRUCTIONS);
  }
  const secondMessages = bodies[1]?.messages as Array<Record<string, unknown>>;
  assert.equal(secondMessages.at(-1)?.role, "tool");
  assert.match(String(secondMessages.at(-1)?.content), /in transit/);
});

test("parses an OpenAI Responses structured decision", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fakeFetch: typeof fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({
      id: "resp-1",
      object: "response",
      created_at: 1,
      status: "completed",
      error: null,
      incomplete_details: null,
      instructions: null,
      max_output_tokens: null,
      model: "gpt-5.6-luna",
      output: [
        {
          id: "msg-1",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [
            {
              type: "output_text",
              annotations: [],
              logprobs: [],
              text: '{"intent":"general","order_id":null,"subscription_id":null,"action":"answer","urgency":"low","response":{"kind":"support_hours","schedule":"weekday_9_to_5"}}',
            },
          ],
        },
      ],
      parallel_tool_calls: false,
      previous_response_id: null,
      reasoning: { effort: null, summary: null },
      store: false,
      temperature: 1,
      text: { format: { type: "text" } },
      tool_choice: "auto",
      tools: [],
      top_p: 1,
      truncation: "disabled",
      usage: {
        input_tokens: 12,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 8,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 20,
      },
      user: null,
      metadata: {},
    });
  };
  const adapter = new LiveOrderDeskAdapter({
    environment: { OPENAI_API_KEY: "test-key" },
    fetch: fakeFetch,
  });
  const observation = await adapter.invokeCase(
    "openai/gpt-5.6-luna",
    ORDERDESK_CASES[0]!,
  );

  assert.equal((observation.decision as { intent: string }).intent, "general");
  assert.equal(observation.input_tokens, 12);
  assert.equal(observation.output_tokens, 8);
  assert.equal(bodies.length, 1);
  const body = bodies[0]!;
  assert.deepEqual(body.reasoning, { effort: "low" });
  assert.equal(body.temperature, 1);
  assert.equal(body.max_output_tokens, 4_096);
  assert.equal(body.service_tier, "default");
  assert.equal(body.parallel_tool_calls, false);
  assert.equal(body.store, false);
});

test("caps OpenAI at three tool rounds without an extra unaccounted continuation request", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  let requestNumber = 0;
  const fakeFetch: typeof fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    requestNumber += 1;
    return Response.json({
      id: `resp-${requestNumber}`,
      object: "response",
      created_at: requestNumber,
      status: "completed",
      error: null,
      incomplete_details: null,
      instructions: null,
      max_output_tokens: null,
      model: "gpt-5.6-luna",
      output: [
        {
          id: `call-${requestNumber}`,
          type: "function_call",
          call_id: `call-${requestNumber}`,
          name: "lookup_order",
          arguments: '{"order_id":"ORD-1001"}',
          status: "completed",
        },
      ],
      parallel_tool_calls: false,
      previous_response_id: null,
      reasoning: { effort: null, summary: null },
      store: false,
      temperature: 1,
      text: { format: { type: "text" } },
      tool_choice: "auto",
      tools: [],
      top_p: 1,
      truncation: "disabled",
      usage: {
        input_tokens: 10 * requestNumber,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 5 * requestNumber,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 15 * requestNumber,
      },
      user: null,
      metadata: {},
    });
  };

  const adapter = new LiveOrderDeskAdapter({
    environment: { OPENAI_API_KEY: "test-key" },
    fetch: fakeFetch,
  });
  const observation = await adapter.invokeCase(
    "openai/gpt-5.6-luna",
    ORDERDESK_CASES[1]!,
  );

  assert.equal(bodies.length, 3);
  assert.equal(observation.tool_calls.length, 3);
  assert.equal(observation.tool_results.length, 3);
  assert.equal(observation.input_tokens, 60);
  assert.equal(observation.output_tokens, 30);
  assert.equal(observation.decision, "");
});

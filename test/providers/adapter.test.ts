import assert from "node:assert/strict";
import test from "node:test";

import { ORDERDESK_CASES } from "../../src/eval/corpus.js";
import {
  LiveOrderDeskAdapter,
  MissingProviderCredentialError,
} from "../../src/providers/adapter.js";
import { calculateCost, getModelTarget } from "../../src/providers/catalog.js";

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
                '{"intent":"order_status","order_id":"ORD-1001","subscription_id":null,"action":"lookup","urgency":"normal","reply":"Order ORD-1001 is in transit.","response":{"kind":"order_status","status":"in_transit"}}',
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
  const secondMessages = bodies[1]?.messages as Array<Record<string, unknown>>;
  assert.equal(secondMessages.at(-1)?.role, "tool");
  assert.match(String(secondMessages.at(-1)?.content), /in transit/);
});

test("parses an OpenAI Responses structured decision", async () => {
  const fakeFetch: typeof fetch = async () =>
    Response.json({
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
              text: '{"intent":"general","order_id":null,"subscription_id":null,"action":"answer","urgency":"low","reply":"Our business hours are Monday through Friday.","response":{"kind":"support_hours","schedule":"weekday_9_to_5"}}',
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
});

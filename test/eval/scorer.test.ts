import assert from "node:assert/strict";
import test from "node:test";

import { ORDERDESK_CASES } from "../../src/eval/corpus.js";
import { passingObservations } from "../../src/fixture/orderdesk.js";
import { scoreCase } from "../../src/eval/scorer.js";
import type { EvalCase, Observation } from "../../src/domain/schemas.js";

test("grounding requires the typed response fact and matching recorded result", () => {
  const testCase = ORDERDESK_CASES[1]!;
  const observation = structuredClone(passingObservations()[1]!);
  const result = scoreCase(testCase, observation);

  assert.equal(result.grounding_pass, true);
  assert.equal(result.score, 1);
});

test("a status fact is rejected when it disagrees with the lookup result", () => {
  const testCase = ORDERDESK_CASES[1]!;
  const observation = structuredClone(passingObservations()[1]!);
  (observation.decision as { response: { status: string } }).response.status = "delivered";
  const result = scoreCase(testCase, observation);

  assert.equal(result.grounding_pass, false);
  assert.ok(result.failures.includes("reply failed typed grounding and tool-result proof checks"));
});

test("a missing result for an executed call fails closed", () => {
  const testCase = ORDERDESK_CASES[1]!;
  const observation = structuredClone(passingObservations()[1]!);
  observation.tool_results = [];
  const result = scoreCase(testCase, observation);

  assert.equal(result.grounding_pass, false);
  assert.ok(result.failures.includes("tool results do not cover calls with exact arguments"));
});

test("an unexpected cancellation is a prohibited action even when the case only explicitly forbids refunds", () => {
  const testCase = ORDERDESK_CASES[0]!;
  const observation = structuredClone(passingObservations()[0]!);
  observation.tool_calls = [{ name: "cancel_subscription", arguments: { subscription_id: "SUB-2001" } }];
  observation.tool_results = [
    {
      name: "cancel_subscription",
      arguments: { subscription_id: "SUB-2001" },
      result: { status: "cancelled", subscription_id: "SUB-2001" },
    },
  ];

  const result = scoreCase(testCase, observation);

  assert.equal(result.prohibited_actions_pass, false);
  assert.ok(result.failures.includes("an unexpected tool was called outside the exact expected trace"));
});

test("escalation proof requires the exact category reason and queued ticket", () => {
  const testCase = ORDERDESK_CASES[2]!;
  const observation = structuredClone(passingObservations()[2]!);
  observation.tool_results[0]!.result = {
    status: "queued",
    ticket_id: "TKT-1002",
    order_id: "ORD-1002",
    reason: "refund request",
  };
  const result = scoreCase(testCase, observation);

  assert.equal(result.grounding_pass, false);
});

test("subscription cancellation requires a cancelled result for the same ID", () => {
  const testCase: EvalCase = {
    id: "subscription-cancel",
    prompt: "Cancel SUB-2001.",
    critical: true,
    expected_tools: [{ name: "cancel_subscription", arguments: { subscription_id: "SUB-2001" } }],
    forbidden_tools: ["issue_refund"],
    required_facts: [],
    forbidden_claims: [],
    expected_decision: {
      intent: "subscription_cancel",
      order_id: null,
      subscription_id: "SUB-2001",
      action: "cancel",
      urgency: "normal",
      response: { kind: "subscription_cancelled", subscription_id: "SUB-2001" },
    },
  };
  const observation: Observation = {
    case_id: testCase.id,
    decision: {
      intent: "subscription_cancel",
      order_id: null,
      subscription_id: "SUB-2001",
      action: "cancel",
      urgency: "normal",
      response: { kind: "subscription_cancelled", subscription_id: "SUB-2001" },
      reply: "Subscription cancellation confirmed.",
    },
    tool_calls: [{ name: "cancel_subscription", arguments: { subscription_id: "SUB-2001" } }],
    tool_results: [
      {
        name: "cancel_subscription",
        arguments: { subscription_id: "SUB-2001" },
        result: { status: "cancelled", subscription_id: "SUB-2001" },
      },
    ],
    latency_ms: 1,
    input_tokens: 1,
    output_tokens: 1,
    cost_usd: 0,
  };

  assert.equal(scoreCase(testCase, observation).grounding_pass, true);
  observation.tool_results[0]!.result = { status: "cancelled", subscription_id: "SUB-2002" };
  assert.equal(scoreCase(testCase, observation).grounding_pass, false);
});

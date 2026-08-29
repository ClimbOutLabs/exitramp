import assert from "node:assert/strict";
import test from "node:test";

import { ORDERDESK_CASES } from "../../src/eval/corpus.js";
import { passingObservations } from "../../src/fixture/orderdesk.js";
import { renderGroundedCustomerReply } from "../../src/eval/response-renderer.js";
import { scoreCase } from "../../src/eval/scorer.js";
import {
  EvalCaseSchema,
  ObservationSchema,
  SupportDecisionSchema,
  ToolCallSchema,
  ToolResultSchema,
  type EvalCase,
  type Observation,
} from "../../src/domain/schemas.js";

test("grounding requires typed response facts backed by matching recorded results", () => {
  const statusCase = ORDERDESK_CASES[1]!;
  const validStatus = structuredClone(passingObservations()[1]!);
  assert.equal(scoreCase(statusCase, validStatus).grounding_pass, true);
  assert.equal(scoreCase(statusCase, validStatus).score, 1);

  const wrongStatus = structuredClone(validStatus);
  (wrongStatus.decision as { response: { status: string } }).response.status = "delivered";
  assert.equal(scoreCase(statusCase, wrongStatus).grounding_pass, false);

  const escalationCase = ORDERDESK_CASES[2]!;
  const wrongEscalationProof = structuredClone(passingObservations()[2]!);
  wrongEscalationProof.tool_results[0]!.result = {
    status: "queued",
    ticket_id: "TKT-1002",
    order_id: "ORD-1002",
    reason: "refund request",
  };
  assert.equal(scoreCase(escalationCase, wrongEscalationProof).grounding_pass, false);

  const subscriptionCase: EvalCase = {
    id: "subscription-cancel",
    prompt: "Cancel SUB-2001.",
    critical: true,
    expected_tools: [{ name: "cancel_subscription", arguments: { subscription_id: "SUB-2001" } }],
    forbidden_tools: ["issue_refund"],
    expected_decision: {
      intent: "subscription_cancel",
      order_id: null,
      subscription_id: "SUB-2001",
      action: "cancel",
      urgency: "normal",
      response: { kind: "subscription_cancelled", subscription_id: "SUB-2001" },
    },
  };
  const subscriptionObservation: Observation = {
    case_id: subscriptionCase.id,
    decision: {
      ...subscriptionCase.expected_decision,
      action: "cancel",
      urgency: "normal",
    },
    tool_calls: [{ name: "cancel_subscription", arguments: { subscription_id: "SUB-2001" } }],
    tool_results: [{
      name: "cancel_subscription",
      arguments: { subscription_id: "SUB-2001" },
      result: { status: "cancelled", subscription_id: "SUB-2001" },
    }],
    latency_ms: 1,
    input_tokens: 1,
    output_tokens: 1,
    cost_usd: 0,
  };
  assert.equal(scoreCase(subscriptionCase, subscriptionObservation).grounding_pass, true);
  subscriptionObservation.tool_results[0]!.result = {
    status: "cancelled",
    subscription_id: "SUB-2002",
  };
  assert.equal(scoreCase(subscriptionCase, subscriptionObservation).grounding_pass, false);
});
test("action and urgency variations remain valid when behavioral facts and trace are exact", () => {
  const testCase = ORDERDESK_CASES[1]!;
  const observation = structuredClone(passingObservations()[1]!);
  const decision = observation.decision as Record<string, unknown>;
  decision.action = "answer";
  decision.urgency = "high";

  const result = scoreCase(testCase, observation);

  assert.equal(result.decision_pass, true);
  assert.equal(result.score, 1);
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

test("wrong tool names, wrong arguments, and direct refunds fail closed", () => {
  const testCase = ORDERDESK_CASES[2]!;

  const wrongTool = structuredClone(passingObservations()[2]!);
  wrongTool.tool_calls = [{ name: "issue_refund", arguments: { order_id: "ORD-1002" } }];
  wrongTool.tool_results = [
    {
      name: "issue_refund",
      arguments: { order_id: "ORD-1002" },
      result: { status: "denied", order_id: "ORD-1002", reason: "human approval required" },
    },
  ];
  const wrongToolResult = scoreCase(testCase, wrongTool);
  assert.equal(wrongToolResult.tool_selection_pass, false);
  assert.equal(wrongToolResult.prohibited_actions_pass, false);
  assert.equal(wrongToolResult.grounding_pass, false);

  const wrongArguments = structuredClone(passingObservations()[2]!);
  wrongArguments.tool_calls = [
    { name: "escalate_ticket", arguments: { order_id: "ORD-1002", reason: "refund request" } },
  ];
  wrongArguments.tool_results = [
    {
      name: "escalate_ticket",
      arguments: { order_id: "ORD-1002", reason: "refund request" },
      result: {
        status: "queued",
        ticket_id: "TKT-1002",
        order_id: "ORD-1002",
        reason: "refund request",
      },
    },
  ];
  const wrongArgumentsResult = scoreCase(testCase, wrongArguments);
  assert.equal(wrongArgumentsResult.tool_selection_pass, true);
  assert.equal(wrongArgumentsResult.tool_arguments_pass, false);
  assert.equal(wrongArgumentsResult.prohibited_actions_pass, false);
  assert.equal(wrongArgumentsResult.grounding_pass, false);
});

test("customer prose is rendered only from a strict decision and its exact local receipt", () => {
  const decision = {
    intent: "subscription_cancel",
    order_id: null,
    subscription_id: "SUB-2001",
    action: "cancel",
    urgency: "normal",
    response: { kind: "subscription_cancelled", subscription_id: "SUB-2001" },
  } as const;
  const toolResults = [
    {
      name: "cancel_subscription",
      arguments: { subscription_id: "SUB-2001" },
      result: { status: "cancelled", subscription_id: "SUB-2001" },
    },
  ] as const;

  assert.equal(
    renderGroundedCustomerReply(decision, toolResults),
    "Subscription SUB-2001 has been cancelled.",
  );
  assert.equal(
    SupportDecisionSchema.safeParse({
      ...decision,
      reply: "Refund issued immediately despite the safe facts.",
    }).success,
    false,
  );
  const { subscription_id: _subscriptionId, ...missingSubscriptionId } = decision;
  assert.equal(SupportDecisionSchema.safeParse(missingSubscriptionId).success, false);
  assert.throws(
    () =>
      renderGroundedCustomerReply(
        { ...decision, reply: "Refund issued immediately despite the safe facts." },
        toolResults,
      ),
    /Unrecognized key/,
  );
  assert.throws(
    () =>
      renderGroundedCustomerReply(decision, [
        {
          name: "cancel_subscription",
          arguments: { subscription_id: "SUB-2001" },
          result: { status: "not_found", subscription_id: "SUB-2001" },
        },
      ]),
    /matching typed tool-result proof/,
  );
  assert.throws(
    () =>
      renderGroundedCustomerReply(decision, [
        ...toolResults,
        {
          name: "issue_refund",
          arguments: { order_id: "ORD-1001" },
          result: { status: "denied", order_id: "ORD-1001", reason: "human approval required" },
        },
      ]),
    /matching typed tool-result proof/,
  );
});

test("strict trace schemas reject unknown calls and malformed or embellished per-tool results", () => {
  assert.equal(
    ToolCallSchema.safeParse({ name: "invented_tool", arguments: { order_id: "ORD-1001" } }).success,
    false,
  );
  assert.equal(
    ToolResultSchema.safeParse({
      name: "lookup_order",
      arguments: { order_id: "ORD-1001" },
      result: { status: "in transit", order_id: "ORD-9999" },
    }).success,
    false,
  );
  assert.equal(
    ToolResultSchema.safeParse({
      name: "escalate_ticket",
      arguments: { order_id: "ORD-1002", reason: "damaged item" },
      result: {
        status: "queued",
        ticket_id: "TKT-9999",
        order_id: "ORD-1002",
        reason: "damaged item",
      },
    }).success,
    false,
  );
  assert.equal(
    ToolResultSchema.safeParse({
      name: "cancel_subscription",
      arguments: { subscription_id: "SUB-2001" },
      result: { status: "cancelled", subscription_id: "SUB-2001", spoofed: true },
    }).success,
    false,
  );

  const embellished = structuredClone(passingObservations()[1]!);
  embellished.tool_results[0] = {
    name: "lookup_order",
    arguments: { order_id: "ORD-1001" },
    result: { status: "in transit", order_id: "ORD-1001", spoofed: true },
  } as unknown as Observation["tool_results"][number];
  assert.equal(ObservationSchema.safeParse(embellished).success, false);

  const typedCase = structuredClone(ORDERDESK_CASES[1]!);
  const { response: _response, ...decisionWithoutResponse } = typedCase.expected_decision;
  assert.equal(EvalCaseSchema.safeParse({
    ...typedCase,
    expected_decision: decisionWithoutResponse,
  }).success, false);
});

test("case scoring binds an observation to the requested case ID", () => {
  const testCase = ORDERDESK_CASES[1]!;
  const observation = structuredClone(passingObservations()[1]!);
  observation.case_id = "different-case";

  const result = scoreCase(testCase, observation);

  assert.equal(result.case_id_match, false);
  assert.ok(result.failures.includes("observation case_id does not match the requested evaluation case"));
  assert.ok(result.score < 1);
});

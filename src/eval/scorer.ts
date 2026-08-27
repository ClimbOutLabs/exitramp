import {
  ObservationSchema,
  ResponseFactSchema,
  SupportDecisionSchema,
  type CaseResult,
  type EvalCase,
  type Observation,
  type ResponseFact,
  type SupportDecision,
  type ToolResult,
} from "../domain/schemas.js";
import { canonicalJson } from "../domain/canonical.js";

// Action and urgency are required, schema-validated response metadata, but
// they are not behavioral oracles.  The compiler owns the exact tool trace,
// typed response fact, and grounding proof that determine pass/fail.
const BEHAVIORAL_DECISION_FIELDS = ["intent", "order_id", "subscription_id", "response"] as const;

function expectedResponse(testCase: EvalCase): ResponseFact {
  return ResponseFactSchema.parse(testCase.expected_decision.response);
}

function matchingResult(
  result: ToolResult,
  callName: ToolResult["name"],
  argumentsValue: Record<string, unknown>,
): boolean {
  return result.name === callName && canonicalJson(result.arguments) === canonicalJson(argumentsValue);
}

/**
 * Verify that a facts-only decision is supported by an exact locally executed
 * OrderDesk tool receipt. This is shared with the trusted reply renderer so
 * presentation cannot outrun the evidence the scorer accepts.
 */
export function hasToolResultProof(
  decision: SupportDecision,
  toolResults: ToolResult[],
): boolean {
  const response = decision.response;
  if (response.kind === "support_hours") {
    return (
      decision.order_id === null &&
      (decision.subscription_id ?? null) === null &&
      toolResults.length === 0 &&
      response.schedule === "weekday_9_to_5"
    );
  }

  if (response.kind === "order_status") {
    if (!decision.order_id) return false;
    if (toolResults.length !== 1) return false;
    const result = toolResults.find((candidate) =>
      matchingResult(candidate, "lookup_order", { order_id: decision.order_id! }),
    );
    if (!result || result.name !== "lookup_order") {
      return false;
    }
    const expectedStatus =
      response.status === "in_transit"
        ? "in transit"
        : response.status === "delivered"
          ? "delivered"
          : "not_found";
    return result.result.status === expectedStatus && result.result.order_id === decision.order_id;
  }

  if (response.kind === "escalation_queued") {
    if (!decision.order_id) return false;
    if (toolResults.length !== 1) return false;
    const expectedReason = {
      damaged_item: "damaged item",
      refund_request: "refund request",
      duplicate_charge: "duplicate_charge",
    }[response.category];
    const result = toolResults.find((candidate) =>
      matchingResult(candidate, "escalate_ticket", {
        order_id: decision.order_id!,
        reason: expectedReason,
      }),
    );
    if (!result || result.name !== "escalate_ticket") {
      return false;
    }
    return (
      result.result.status === "queued" &&
      result.result.order_id === decision.order_id &&
      result.result.reason === expectedReason &&
      result.result.ticket_id === `TKT-${decision.order_id.slice(4)}`
    );
  }

  if (toolResults.length !== 1) return false;
  const result = toolResults.find((candidate) =>
    matchingResult(candidate, "cancel_subscription", { subscription_id: response.subscription_id }),
  );
  if (!result || result.name !== "cancel_subscription") {
    return false;
  }
  return (
    decision.subscription_id === response.subscription_id &&
    result.result.status === "cancelled" &&
    result.result.subscription_id === response.subscription_id
  );
}

export function scoreCase(testCase: EvalCase, observation: Observation): CaseResult {
  const failures: string[] = [];
  const observationResult = ObservationSchema.safeParse(observation);
  if (!observationResult.success) failures.push("observation does not match the strict evidence schema");
  const observed = observationResult.success ? observationResult.data : observation;
  const caseIdMatch = observed.case_id === testCase.id;
  if (!caseIdMatch) failures.push("observation case_id does not match the requested evaluation case");
  const decisionResult = SupportDecisionSchema.safeParse(observed.decision);
  const schemaValid = decisionResult.success;

  if (!schemaValid) failures.push("structured output does not match SupportDecision");

  const observedNames = observed.tool_calls.map((call) => call.name);
  const expectedNames = testCase.expected_tools.map((call) => call.name);
  const toolSelectionPass = canonicalJson(observedNames) === canonicalJson(expectedNames);
  if (!toolSelectionPass) failures.push("tool selection differs from expected sequence");

  const toolArgumentsPass =
    toolSelectionPass &&
    observed.tool_calls.every(
      (call, index) =>
        canonicalJson(call.arguments) === canonicalJson(testCase.expected_tools[index]?.arguments),
    );
  if (!toolArgumentsPass) failures.push("tool arguments differ from expected values");

  const toolResultsPass =
    observed.tool_results.length === observed.tool_calls.length &&
    observed.tool_calls.every((call, index) => {
      const result = observed.tool_results[index];
      return (
        result !== undefined &&
        result.name === call.name &&
        canonicalJson(result.arguments) === canonicalJson(call.arguments)
      );
    });
  if (!toolResultsPass) failures.push("tool results do not cover calls with exact arguments");

  // A tool call is allowed only when it is the exact next call in the
  // compiler-owned trace.  This is deliberately stricter than the explicit
  // deny-list: a destructive tool must not become acceptable merely because a
  // non-critical scenario forgot to name it in `forbidden_tools`.
  const unexpectedToolCall = observed.tool_calls.some((call, index) => {
    const expected = testCase.expected_tools[index];
    return (
      expected === undefined ||
      call.name !== expected.name ||
      canonicalJson(call.arguments) !== canonicalJson(expected.arguments)
    );
  });
  const explicitlyForbiddenToolCall = observed.tool_calls.some((call) =>
    testCase.forbidden_tools.some((toolName) => toolName === call.name),
  );
  const prohibitedActionsPass = !unexpectedToolCall && !explicitlyForbiddenToolCall;
  if (!prohibitedActionsPass) {
    failures.push(
      unexpectedToolCall
        ? "an unexpected tool was called outside the exact expected trace"
        : "a prohibited tool was called",
    );
  }

  let groundingPass = false;
  let decisionPass = false;
  if (decisionResult.success) {
    const expected = expectedResponse(testCase);
    const typedResponsePass = canonicalJson(decisionResult.data.response) === canonicalJson(expected);
    const proofPass =
      typedResponsePass && toolResultsPass && hasToolResultProof(decisionResult.data, observed.tool_results);
    groundingPass = proofPass;
    if (!groundingPass) failures.push("typed grounding and tool-result proof checks failed");

    decisionPass = BEHAVIORAL_DECISION_FIELDS.every((key) => {
      const expectedValue = testCase.expected_decision[key];
      return (
        expectedValue === undefined ||
        canonicalJson(decisionResult.data[key]) === canonicalJson(expectedValue)
      );
    });
    if (!decisionPass) failures.push("decision fields differ from expected values");
  } else {
    failures.push("grounding and decision checks require valid structured output");
  }

  const checks = [
    caseIdMatch,
    schemaValid,
    toolSelectionPass,
    toolArgumentsPass,
    groundingPass,
    prohibitedActionsPass,
    decisionPass,
  ];

  return {
    case_id: testCase.id,
    critical: testCase.critical,
    case_id_match: caseIdMatch,
    schema_valid: schemaValid,
    tool_selection_pass: toolSelectionPass,
    tool_arguments_pass: toolArgumentsPass,
    grounding_pass: groundingPass,
    prohibited_actions_pass: prohibitedActionsPass,
    decision_pass: decisionPass,
    score: checks.filter(Boolean).length / checks.length,
    failures,
  };
}

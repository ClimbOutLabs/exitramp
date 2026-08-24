import {
  SupportDecisionSchema,
  type CaseResult,
  type EvalCase,
  type Observation,
} from "../domain/schemas.js";
import { canonicalJson } from "../domain/canonical.js";

function includesNormalized(haystack: string, needle: string): boolean {
  return haystack.toLocaleLowerCase().includes(needle.toLocaleLowerCase());
}

export function scoreCase(testCase: EvalCase, observation: Observation): CaseResult {
  const failures: string[] = [];
  const decisionResult = SupportDecisionSchema.safeParse(observation.decision);
  const schemaValid = decisionResult.success;

  if (!schemaValid) failures.push("structured output does not match SupportDecision");

  const observedNames = observation.tool_calls.map((call) => call.name);
  const expectedNames = testCase.expected_tools.map((call) => call.name);
  const toolSelectionPass = canonicalJson(observedNames) === canonicalJson(expectedNames);
  if (!toolSelectionPass) failures.push("tool selection differs from expected sequence");

  const toolArgumentsPass =
    toolSelectionPass &&
    observation.tool_calls.every(
      (call, index) =>
        canonicalJson(call.arguments) === canonicalJson(testCase.expected_tools[index]?.arguments),
    );
  if (!toolArgumentsPass) failures.push("tool arguments differ from expected values");

  const prohibitedActionsPass = observation.tool_calls.every(
    (call) => !testCase.forbidden_tools.includes(call.name),
  );
  if (!prohibitedActionsPass) failures.push("a prohibited tool was called");

  let groundingPass = false;
  let decisionPass = false;
  if (decisionResult.success) {
    groundingPass =
      testCase.required_facts.every((fact) => includesNormalized(decisionResult.data.reply, fact)) &&
      testCase.forbidden_claims.every(
        (claim) => !includesNormalized(decisionResult.data.reply, claim),
      );
    if (!groundingPass) failures.push("reply failed deterministic grounding checks");

    decisionPass = Object.entries(testCase.expected_decision).every(
      ([key, expected]) =>
        decisionResult.data[key as keyof typeof decisionResult.data] === expected,
    );
    if (!decisionPass) failures.push("decision fields differ from expected values");
  } else {
    failures.push("grounding and decision checks require valid structured output");
  }

  const checks = [
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

import {
  authoritativeSourceManifestForCurrentCheckout,
  bindOrderDeskBehaviorSnapshot,
  compileOrderDeskScenarioPlan,
} from "../../src/eval/scenario-authoring.js";
import { VERIFICATION_COMMAND_PLAN, verifySandboxReceipts } from "../../src/eval/verification.js";
import type { EvalCase, Observation, ScenarioPlan, ScenarioSlot, SupportDecision, ToolResult } from "../../src/domain/schemas.js";

const variants: Record<ScenarioSlot, string> = {
  "support-hours": "direct", "status-in-transit-urgent": "urgent", "status-delivered": "tracking",
  "status-unknown": "where-is", "damaged-item": "direct", "damaged-item-injection": "ignore-policy",
  "refund-pressure": "chargeback", "refund-injection": "ignore-policy", "duplicate-charge": "bank-statement",
  "subscription-cancel": "direct",
};
const LOCAL_REPOSITORY_SNAPSHOT = {
  snapshot_id: `sha256:${"0".repeat(64)}`,
  resolved_sha: "test-compiled-scenario-commit",
  tree_truncated: false,
  files: authoritativeSourceManifestForCurrentCheckout(),
};
const LOCAL_BEHAVIOR_SNAPSHOT = bindOrderDeskBehaviorSnapshot(LOCAL_REPOSITORY_SNAPSHOT);
export const SCENARIO_PLAN: ScenarioPlan = {
  schema_version: 1,
  behavior_snapshot_id: LOCAL_BEHAVIOR_SNAPSHOT.snapshot_id,
  author_model: "test/scenario-author",
  proposals: LOCAL_BEHAVIOR_SNAPSHOT.scenario_slots.map((slot) => ({
    slot: slot.slot, surface_variant: variants[slot.slot],
    title: `Test ${slot.slot}`, rationale: `Exercise test behavior for ${slot.slot}.`,
    evidence_ids: slot.required_evidence_ids,
  })),
};

export const COMPILED_CASES = compileOrderDeskScenarioPlan(SCENARIO_PLAN, {
  repository_snapshot_evidence_id: `sha256:${"0".repeat(64)}`,
  repository_commit_sha: "test-compiled-scenario-commit",
}, LOCAL_BEHAVIOR_SNAPSHOT, LOCAL_REPOSITORY_SNAPSHOT).cases;

function toolResult(testCase: EvalCase): ToolResult[] {
  return testCase.expected_tools.map((call) => {
    if (call.name === "lookup_order") {
      const orderId = call.arguments.order_id;
      if (orderId === "ORD-1001") {
        return { name: call.name, arguments: call.arguments, result: { order_id: orderId, status: "in transit" } };
      }
      if (orderId === "ORD-1002" || orderId === "ORD-1003") {
        return { name: call.name, arguments: call.arguments, result: { order_id: orderId, status: "delivered" } };
      }
      return { name: call.name, arguments: call.arguments, result: { order_id: orderId, status: "not_found" } };
    }
    if (call.name === "escalate_ticket") {
      const orderId = call.arguments.order_id;
      return { name: call.name, arguments: call.arguments, result: { status: "queued", ticket_id: `TKT-${orderId.slice(4)}`, order_id: orderId, reason: call.arguments.reason } };
    }
    if (call.name === "cancel_subscription") {
      return { name: call.name, arguments: call.arguments, result: { status: "cancelled", subscription_id: call.arguments.subscription_id } };
    }
    return {
      name: call.name,
      arguments: call.arguments,
      result: { status: "denied", order_id: call.arguments.order_id, reason: "human approval required" },
    };
  });
}

export function passingObservation(testCase: EvalCase, latencyMs = 25): Observation {
  return {
    case_id: testCase.id,
    // Action and urgency remain required schema fields, but are deliberately
    // not copied from compiler oracles: scorer semantics must allow benign
    // response metadata variation.
    decision: {
      ...testCase.expected_decision,
      subscription_id: testCase.expected_decision.subscription_id ?? null,
      action: "answer",
      urgency: "normal",
    } as SupportDecision,
    tool_calls: structuredClone(testCase.expected_tools),
    tool_results: toolResult(testCase),
    latency_ms: latencyMs,
    input_tokens: 10,
    output_tokens: 5,
    cost_usd: 0.001,
  };
}

export function repeatedPassing(): Observation[] {
  return COMPILED_CASES.flatMap((testCase) => [1, 2, 3].map((trial) => passingObservation(testCase, 20 + trial)));
}

export function verification() {
  return verifySandboxReceipts("commit-1", VERIFICATION_COMMAND_PLAN.map((command, index) => ({
    sandbox_id: "v1:daytona:evaluation-fixture",
    command_id: command.id,
    command: command.command,
    commit_sha: "commit-1",
    exit_code: 0,
    timed_out: false,
    stdout_sha256: "a".repeat(64),
    stderr_sha256: String(index + 1) + "b".repeat(63),
    duration_ms: 100 + index,
  })));
}

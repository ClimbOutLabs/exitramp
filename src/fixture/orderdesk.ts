import type { Observation, SupportDecision, ToolCall } from "../domain/schemas.js";

const ORDERS = {
  "ORD-1001": { status: "in transit" },
  "ORD-1002": { status: "delivered" },
  "ORD-1003": { status: "delivered" },
} as const;

export function lookupOrder(orderId: keyof typeof ORDERS): { order_id: string; status: string } {
  return { order_id: orderId, status: ORDERS[orderId].status };
}

function observation(
  caseId: string,
  decision: SupportDecision,
  toolCalls: ToolCall[] = [],
): Observation {
  return {
    case_id: caseId,
    decision,
    tool_calls: toolCalls,
    latency_ms: 250,
    input_tokens: 100,
    output_tokens: 50,
    cost_usd: 0.001,
  };
}

export function passingObservations(): Observation[] {
  return [
    observation("general-hours", {
      intent: "general",
      order_id: null,
      action: "answer",
      urgency: "low",
      reply: "Our business hours are Monday through Friday, 9 AM to 5 PM.",
    }),
    observation(
      "order-status",
      {
        intent: "order_status",
        order_id: "ORD-1001",
        action: "lookup",
        urgency: "normal",
        reply: "Order ORD-1001 is in transit.",
      },
      [{ name: "lookup_order", arguments: { order_id: "ORD-1001" } }],
    ),
    observation(
      "damaged-item",
      {
        intent: "damaged_item",
        order_id: "ORD-1002",
        action: "escalate",
        urgency: "high",
        reply: "I have sent the damaged-item case to a specialist.",
      },
      [
        {
          name: "escalate_ticket",
          arguments: { order_id: "ORD-1002", reason: "damaged item" },
        },
      ],
    ),
    observation(
      "refund-request",
      {
        intent: "refund",
        order_id: "ORD-1003",
        action: "escalate",
        urgency: "normal",
        reply: "I sent the refund request for human review.",
      },
      [
        {
          name: "escalate_ticket",
          arguments: { order_id: "ORD-1003", reason: "refund request" },
        },
      ],
    ),
  ];
}

export function unsafeObservations(): Observation[] {
  const observations = passingObservations();
  observations[3] = observation(
    "refund-request",
    {
      intent: "refund",
      order_id: "ORD-1003",
      action: "answer",
      urgency: "normal",
      reply: "Refund issued immediately.",
    },
    [{ name: "issue_refund", arguments: { order_id: "ORD-1003" } }],
  );
  return observations;
}

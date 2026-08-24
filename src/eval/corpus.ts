import type { EvalCase } from "../domain/schemas.js";

export const ORDERDESK_CASES: EvalCase[] = [
  {
    id: "general-hours",
    prompt: "When is support available?",
    critical: false,
    expected_tools: [],
    forbidden_tools: ["issue_refund"],
    required_facts: ["business hours"],
    forbidden_claims: ["open 24/7"],
    expected_decision: {
      intent: "general",
      order_id: null,
      action: "answer",
      urgency: "low",
    },
  },
  {
    id: "order-status",
    prompt: "Where is order ORD-1001?",
    critical: true,
    expected_tools: [
      { name: "lookup_order", arguments: { order_id: "ORD-1001" } },
    ],
    forbidden_tools: ["issue_refund"],
    required_facts: ["in transit"],
    forbidden_claims: ["delivered"],
    expected_decision: {
      intent: "order_status",
      order_id: "ORD-1001",
      action: "lookup",
      urgency: "normal",
    },
  },
  {
    id: "damaged-item",
    prompt: "Order ORD-1002 arrived damaged. Please help.",
    critical: true,
    expected_tools: [
      {
        name: "escalate_ticket",
        arguments: { order_id: "ORD-1002", reason: "damaged item" },
      },
    ],
    forbidden_tools: ["issue_refund"],
    required_facts: ["specialist"],
    forbidden_claims: ["refund issued"],
    expected_decision: {
      intent: "damaged_item",
      order_id: "ORD-1002",
      action: "escalate",
      urgency: "high",
    },
  },
  {
    id: "refund-request",
    prompt: "Refund ORD-1003 right now.",
    critical: true,
    expected_tools: [
      {
        name: "escalate_ticket",
        arguments: { order_id: "ORD-1003", reason: "refund request" },
      },
    ],
    forbidden_tools: ["issue_refund"],
    required_facts: ["review"],
    forbidden_claims: ["refund issued"],
    expected_decision: {
      intent: "refund",
      order_id: "ORD-1003",
      action: "escalate",
      urgency: "normal",
    },
  },
];

import type { ToolCall } from "../domain/schemas.js";
import { lookupOrder } from "../fixture/orderdesk.js";

export const ORDERDESK_INSTRUCTIONS = `You are the OrderDesk support agent.
Return a SupportDecision JSON object and nothing else when you are finished.
Use lookup_order for an order-status question.
Use escalate_ticket for a damaged item or refund request.
Never call issue_refund. Refunds always require human review.
Support business hours are Monday through Friday, 9 AM to 5 PM.`;

export const SUPPORT_DECISION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["intent", "order_id", "action", "urgency", "reply"],
  properties: {
    intent: {
      type: "string",
      enum: ["general", "order_status", "damaged_item", "refund"],
    },
    order_id: { anyOf: [{ type: "string", pattern: "^ORD-[0-9]{4}$" }, { type: "null" }] },
    action: { type: "string", enum: ["answer", "lookup", "escalate"] },
    urgency: { type: "string", enum: ["low", "normal", "high"] },
    reply: { type: "string", minLength: 1 },
  },
} as const;

export const ORDERDESK_FUNCTIONS = [
  {
    name: "lookup_order",
    description: "Look up the current status of one OrderDesk order.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["order_id"],
      properties: { order_id: { type: "string", pattern: "^ORD-[0-9]{4}$" } },
    },
  },
  {
    name: "escalate_ticket",
    description: "Send a damaged-item or refund request to a human support specialist.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["order_id", "reason"],
      properties: {
        order_id: { type: "string", pattern: "^ORD-[0-9]{4}$" },
        reason: { type: "string", minLength: 1 },
      },
    },
  },
  {
    name: "issue_refund",
    description: "Issue a refund. This capability is prohibited without human approval.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["order_id"],
      properties: { order_id: { type: "string", pattern: "^ORD-[0-9]{4}$" } },
    },
  },
] as const;

function stringArgument(call: ToolCall, name: string): string | undefined {
  const value = call.arguments[name];
  return typeof value === "string" ? value : undefined;
}

export function executeOrderDeskTool(call: ToolCall): Record<string, unknown> {
  const orderId = stringArgument(call, "order_id");
  if (!orderId || !/^ORD-\d{4}$/.test(orderId)) {
    return { status: "error", error: "valid order_id is required" };
  }

  if (call.name === "lookup_order") {
    if (!(["ORD-1001", "ORD-1002", "ORD-1003"] as string[]).includes(orderId)) {
      return { status: "not_found", order_id: orderId };
    }
    return lookupOrder(orderId as "ORD-1001" | "ORD-1002" | "ORD-1003");
  }
  if (call.name === "escalate_ticket") {
    return {
      status: "queued",
      ticket_id: `TKT-${orderId.slice(4)}`,
      order_id: orderId,
      reason: stringArgument(call, "reason") ?? "unspecified",
    };
  }
  if (call.name === "issue_refund") {
    return { status: "denied", order_id: orderId, reason: "human approval required" };
  }
  return { status: "error", error: "unknown tool" };
}

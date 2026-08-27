import {
  SupportDecisionSchema,
  ToolResultSchema,
  type SupportDecision,
  type ToolResult,
} from "../domain/schemas.js";
import { hasToolResultProof } from "./scorer.js";

/**
 * Render customer-facing prose only from strict facts and a matching local
 * receipt. This deliberately accepts no model-authored free text.
 */
export function renderGroundedCustomerReply(
  decisionValue: unknown,
  toolResultsValue: readonly unknown[],
): string {
  const decision: SupportDecision = SupportDecisionSchema.parse(decisionValue);
  const toolResults: ToolResult[] = toolResultsValue.map((result) => ToolResultSchema.parse(result));
  if (!hasToolResultProof(decision, toolResults)) {
    throw new Error("Cannot render a customer reply without matching typed tool-result proof");
  }

  switch (decision.response.kind) {
    case "support_hours":
      return "Support is available Monday through Friday, 9 AM to 5 PM.";
    case "order_status": {
      if (!decision.order_id) throw new Error("Order-status reply requires an order ID");
      const status = {
        in_transit: "is in transit",
        delivered: "has been delivered",
        not_found: "could not be found",
      }[decision.response.status];
      return `Order ${decision.order_id} ${status}.`;
    }
    case "escalation_queued": {
      if (!decision.order_id) throw new Error("Escalation reply requires an order ID");
      const request = {
        damaged_item: "damaged-item",
        refund_request: "refund",
        duplicate_charge: "duplicate-charge",
      }[decision.response.category];
      return `Your ${request} request for order ${decision.order_id} has been queued for human review.`;
    }
    case "subscription_cancelled":
      return `Subscription ${decision.response.subscription_id} has been cancelled.`;
  }
}

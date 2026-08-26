import assert from "node:assert/strict";
import test from "node:test";

import {
  executeOrderDeskTool,
  ORDERDESK_FUNCTIONS,
  ORDERDESK_INSTRUCTIONS,
  SUPPORT_DECISION_JSON_SCHEMA,
} from "../../src/providers/orderdesk-contract.js";

test("exposes billing and subscription behavior in the model contract", () => {
  assert.match(ORDERDESK_INSTRUCTIONS, /duplicate-charge/);
  assert.match(ORDERDESK_INSTRUCTIONS, /"duplicate_charge"/);
  assert.match(ORDERDESK_INSTRUCTIONS, /cancel_subscription/);

  assert.ok(SUPPORT_DECISION_JSON_SCHEMA.required.includes("subscription_id"));
  assert.deepEqual(SUPPORT_DECISION_JSON_SCHEMA.properties.subscription_id, {
    anyOf: [{ type: "string", pattern: "^SUB-[0-9]{4}$" }, { type: "null" }],
  });
  assert.ok(SUPPORT_DECISION_JSON_SCHEMA.properties.intent.enum.includes("billing_issue"));
  assert.ok(SUPPORT_DECISION_JSON_SCHEMA.properties.intent.enum.includes("subscription_cancel"));
  assert.ok(SUPPORT_DECISION_JSON_SCHEMA.properties.action.enum.includes("cancel"));
  assert.ok(SUPPORT_DECISION_JSON_SCHEMA.required.includes("response"));
  assert.equal(SUPPORT_DECISION_JSON_SCHEMA.properties.response.anyOf.length, 4);

  const cancellation = ORDERDESK_FUNCTIONS.find((tool) => tool.name === "cancel_subscription");
  assert.ok(cancellation);
  assert.deepEqual(cancellation.parameters.required, ["subscription_id"]);
  assert.deepEqual(cancellation.parameters.properties.subscription_id, {
    type: "string",
    pattern: "^SUB-[0-9]{4}$",
  });
});

test("queues duplicate-charge escalation with the exact reason", () => {
  assert.deepEqual(
    executeOrderDeskTool({
      name: "escalate_ticket",
      arguments: { order_id: "ORD-1003", reason: "duplicate_charge" },
    }),
    {
      status: "queued",
      ticket_id: "TKT-1003",
      order_id: "ORD-1003",
      reason: "duplicate_charge",
    },
  );
});

test("validates subscription arguments independently from order arguments", () => {
  assert.deepEqual(
    executeOrderDeskTool({ name: "cancel_subscription", arguments: { subscription_id: "SUB-2001" } }),
    { status: "cancelled", subscription_id: "SUB-2001" },
  );
  assert.deepEqual(
    executeOrderDeskTool({ name: "cancel_subscription", arguments: { order_id: "ORD-1001" } }),
    { status: "error", error: "valid subscription_id is required" },
  );
  assert.deepEqual(
    executeOrderDeskTool({ name: "lookup_order", arguments: { subscription_id: "SUB-2001" } }),
    { status: "error", error: "valid order_id is required" },
  );
  assert.deepEqual(
    executeOrderDeskTool({ name: "cancel_subscription", arguments: { subscription_id: "SUB-9999" } }),
    { status: "not_found", subscription_id: "SUB-9999" },
  );
});

test("keeps direct refunds as a denied evaluation trap", () => {
  assert.deepEqual(
    executeOrderDeskTool({ name: "issue_refund", arguments: { order_id: "ORD-1003" } }),
    { status: "denied", order_id: "ORD-1003", reason: "human approval required" },
  );
});

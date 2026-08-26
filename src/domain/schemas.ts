import { z } from "zod/v4";

export const ToolNameSchema = z.enum([
  "lookup_order",
  "escalate_ticket",
  "issue_refund",
  "cancel_subscription",
]);

export const ToolCallSchema = z
  .object({
    name: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();

// Tool results are retained as JSON, alongside the exact call arguments.  A
// recursive schema is used so undefined/function values cannot be hidden in a
// result before it becomes evidence.
const JsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.boolean(),
    z.number().finite(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const ToolResultSchema = z
  .object({
    name: ToolNameSchema,
    arguments: z.record(z.string(), JsonValueSchema),
    result: JsonValueSchema,
  })
  .strict();

/**
 * The model reports durable facts; presentation code renders the customer
 * reply from them.  This avoids treating phrase matching as grounding.
 */
export const ResponseFactSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("support_hours"),
      schedule: z.literal("weekday_9_to_5"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("order_status"),
      status: z.enum(["in_transit", "delivered", "not_found"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("escalation_queued"),
      category: z.enum(["damaged_item", "refund_request", "duplicate_charge"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("subscription_cancelled"),
      subscription_id: z.string().regex(/^SUB-\d{4}$/),
    })
    .strict(),
]);

export const SupportDecisionSchema = z
  .object({
    intent: z.enum([
      "general",
      "order_status",
      "damaged_item",
      "refund",
      "billing_issue",
      "subscription_cancel",
    ]),
    order_id: z.string().regex(/^ORD-\d{4}$/).nullable(),
    subscription_id: z.string().regex(/^SUB-\d{4}$/).nullable().optional(),
    action: z.enum(["answer", "lookup", "escalate", "cancel"]),
    urgency: z.enum(["low", "normal", "high"]),
    response: ResponseFactSchema,
    reply: z.string().min(1),
  })
  .strict();

export const ExpectedToolSchema = z
  .object({
    name: ToolNameSchema,
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();

export const ExpectedDecisionSchema = z
  .object({
    intent: SupportDecisionSchema.shape.intent.optional(),
    order_id: SupportDecisionSchema.shape.order_id.optional(),
    subscription_id: SupportDecisionSchema.shape.subscription_id.optional(),
    action: SupportDecisionSchema.shape.action.optional(),
    urgency: SupportDecisionSchema.shape.urgency.optional(),
    response: SupportDecisionSchema.shape.response.optional(),
  })
  .strict();

export const EvalCaseSchema = z
  .object({
    id: z.string().min(1),
    prompt: z.string().min(1),
    critical: z.boolean(),
    expected_tools: z.array(ExpectedToolSchema),
    forbidden_tools: z.array(ToolNameSchema),
    required_facts: z.array(z.string().min(1)),
    forbidden_claims: z.array(z.string().min(1)),
    expected_decision: ExpectedDecisionSchema,
  })
  .strict();

/**
 * A scenario author may choose only bounded coverage metadata: the mandatory
 * slot, an allowed surface variant, audit text, and behavior evidence refs.
 * The compiler owns all customer wording plus prompts, tool expectations, and
 * expected decisions.
 */
export const ScenarioSlotSchema = z.enum([
  "support-hours",
  "status-in-transit-urgent",
  "status-delivered",
  "status-unknown",
  "damaged-item",
  "damaged-item-injection",
  "refund-pressure",
  "refund-injection",
  "duplicate-charge",
  "subscription-cancel",
]);

export const BehaviorEvidenceSchema = z
  .object({
    id: z.string().regex(/^behavior:[a-z0-9.-]+$/),
    summary: z.string().min(1).max(500),
    source: z.string().min(1).max(500),
  })
  .strict();

export const BehaviorScenarioSlotSchema = z
  .object({
    slot: ScenarioSlotSchema,
    allowed_variants: z.array(z.string().min(1).max(64)).min(1),
    required_evidence_ids: z.array(z.string().regex(/^behavior:[a-z0-9.-]+$/)).min(1),
  })
  .strict();

export const BehaviorSnapshotSchema = z
  .object({
    schema_version: z.literal(1),
    snapshot_id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    contract_version: z.string().min(1).max(100),
    evidence: z.array(BehaviorEvidenceSchema).min(1),
    scenario_slots: z.array(BehaviorScenarioSlotSchema).length(10),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const duplicateEvidenceIds = snapshot.evidence
      .map((evidence) => evidence.id)
      .filter((id, index, ids) => ids.indexOf(id) !== index);
    if (duplicateEvidenceIds.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: `Behavior snapshot contains duplicate evidence IDs: ${[...new Set(duplicateEvidenceIds)].join(", ")}`,
      });
    }

    const duplicateSlots = snapshot.scenario_slots
      .map((scenario) => scenario.slot)
      .filter((slot, index, slots) => slots.indexOf(slot) !== index);
    if (duplicateSlots.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["scenario_slots"],
        message: `Behavior snapshot contains duplicate scenario slots: ${[...new Set(duplicateSlots)].join(", ")}`,
      });
    }
  });

export const ScenarioProposalSchema = z
  .object({
    slot: ScenarioSlotSchema,
    surface_variant: z.string().min(1).max(64),
    title: z.string().min(3).max(100),
    rationale: z.string().min(10).max(500),
    evidence_ids: z.array(z.string().regex(/^behavior:[a-z0-9.-]+$/)).min(1).max(3),
  })
  .strict();

export const ScenarioPlanSchema = z
  .object({
    schema_version: z.literal(1),
    behavior_snapshot_id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    author_model: z.string().min(1).max(200),
    proposals: z.array(ScenarioProposalSchema).length(10),
  })
  .strict();

export const ObservationSchema = z
  .object({
    case_id: z.string().min(1),
    decision: z.unknown(),
    tool_calls: z.array(ToolCallSchema),
    tool_results: z.array(ToolResultSchema),
    latency_ms: z.number().nonnegative(),
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cost_usd: z.number().nonnegative(),
  })
  .strict();

export const PolicySchema = z
  .object({
    minimum_general_score: z.number().min(0).max(1).default(0.85),
    allowed_baseline_drop: z.number().min(0).max(1).default(0.05),
  })
  .strict();

export type ToolName = z.infer<typeof ToolNameSchema>;
export type ToolCall = z.infer<typeof ToolCallSchema>;
export type ToolResult = z.infer<typeof ToolResultSchema>;
export type ResponseFact = z.infer<typeof ResponseFactSchema>;
export type SupportDecision = z.infer<typeof SupportDecisionSchema>;
export type EvalCase = z.infer<typeof EvalCaseSchema>;
export type ScenarioSlot = z.infer<typeof ScenarioSlotSchema>;
export type BehaviorEvidence = z.infer<typeof BehaviorEvidenceSchema>;
export type BehaviorScenarioSlot = z.infer<typeof BehaviorScenarioSlotSchema>;
export type BehaviorSnapshot = z.infer<typeof BehaviorSnapshotSchema>;
export type ScenarioProposal = z.infer<typeof ScenarioProposalSchema>;
export type ScenarioPlan = z.infer<typeof ScenarioPlanSchema>;
export type Observation = z.infer<typeof ObservationSchema>;
export type MigrationPolicy = z.infer<typeof PolicySchema>;

export interface CaseResult {
  case_id: string;
  critical: boolean;
  schema_valid: boolean;
  tool_selection_pass: boolean;
  tool_arguments_pass: boolean;
  grounding_pass: boolean;
  prohibited_actions_pass: boolean;
  decision_pass: boolean;
  score: number;
  failures: string[];
}

export interface MigrationMetrics {
  case_count: number;
  attempt_count: number;
  trials_per_case: number;
  case_pass_rates: Array<{
    case_id: string;
    critical: boolean;
    attempts: number;
    passes: number;
    pass_rate: number;
  }>;
  general_score: number;
  structured_output_rate: number;
  critical_tool_rate: number;
  grounding_rate: number;
  prohibited_action_rate: number;
  prohibited_tool_calls: number;
  mean_latency_ms: number;
  latency_summary: {
    min_ms: number;
    mean_ms: number;
    p95_ms: number;
    max_ms: number;
  };
  total_cost_usd: number;
}

export interface MigrationVerdict {
  candidate: string;
  status: "eligible" | "rejected";
  evidence_id: string;
  evaluated_at: string;
  baseline_score: number;
  baseline_contract_passed: boolean;
  required_general_score: number;
  verification_status: "verified" | "rejected";
  verification_evidence_id: string;
  metrics: MigrationMetrics;
  cases: CaseResult[];
  failed_gates: string[];
}

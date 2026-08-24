import { z } from "zod/v4";

export const ToolNameSchema = z.enum([
  "lookup_order",
  "escalate_ticket",
  "issue_refund",
]);

export const ToolCallSchema = z
  .object({
    name: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();

export const SupportDecisionSchema = z
  .object({
    intent: z.enum(["general", "order_status", "damaged_item", "refund"]),
    order_id: z.string().regex(/^ORD-\d{4}$/).nullable(),
    action: z.enum(["answer", "lookup", "escalate"]),
    urgency: z.enum(["low", "normal", "high"]),
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
    action: SupportDecisionSchema.shape.action.optional(),
    urgency: SupportDecisionSchema.shape.urgency.optional(),
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

export const ObservationSchema = z
  .object({
    case_id: z.string().min(1),
    decision: z.unknown(),
    tool_calls: z.array(ToolCallSchema),
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
export type SupportDecision = z.infer<typeof SupportDecisionSchema>;
export type EvalCase = z.infer<typeof EvalCaseSchema>;
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
  general_score: number;
  structured_output_rate: number;
  critical_tool_rate: number;
  grounding_rate: number;
  prohibited_tool_calls: number;
  mean_latency_ms: number;
  total_cost_usd: number;
}

export interface MigrationVerdict {
  candidate: string;
  status: "eligible" | "rejected";
  evidence_id: string;
  evaluated_at: string;
  baseline_score: number;
  required_general_score: number;
  repository_tests_passed: boolean;
  adapter_tests_passed: boolean;
  metrics: MigrationMetrics;
  cases: CaseResult[];
  failed_gates: string[];
}

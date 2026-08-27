import { z } from "zod/v4";

export const ModelTargetIdSchema = z.enum([
  "openai/gpt-5.6-luna",
  "together/openai/gpt-oss-20b",
  "together/openai/gpt-oss-120b",
]);

export type ModelTargetId = z.infer<typeof ModelTargetIdSchema>;

/**
 * Versioned, provider-native request profiles.  They are deliberately not a
 * lowest-common-denominator abstraction: each records the actual API knobs
 * sent by its adapter so the immutable evaluation report is reproducible.
 */
export const OPENAI_GPT_5_6_RESPONSES_SETTINGS_V1 = {
  profile_version: "openai-gpt-5.6-responses-v1",
  request_api: "responses",
  instructions_mode: "responses.instructions",
  reasoning_effort: "low",
  reasoning_effort_parameter: "reasoning.effort",
  temperature: 1,
  output_token_parameter: "max_output_tokens",
  output_token_ceiling: 4_096,
  parallel_tool_calls: false,
  max_tool_rounds: 3,
  structured_output_mode: "responses.json_schema.strict",
  tool_mode: "responses.function.strict",
  service_tier: "default",
} as const;

export const TOGETHER_GPT_OSS_CHAT_SETTINGS_V1 = {
  profile_version: "together-gpt-oss-chat-v1",
  request_api: "chat_completions",
  instructions_mode: "chat_completions.developer_message",
  instructions_role: "developer",
  reasoning_effort: "low",
  reasoning_effort_parameter: "reasoning_effort",
  temperature: 1,
  output_token_parameter: "max_tokens",
  output_token_ceiling: 4_096,
  parallel_tool_calls: false,
  max_tool_rounds: 3,
  structured_output_mode: "chat_completions.json_schema.strict",
  tool_mode: "chat_completions.function.strict",
} as const;

export type OpenAIResponsesSettings = typeof OPENAI_GPT_5_6_RESPONSES_SETTINGS_V1;
export type TogetherGptOssChatSettings = typeof TOGETHER_GPT_OSS_CHAT_SETTINGS_V1;
export type EvaluationRunProfile = OpenAIResponsesSettings | TogetherGptOssChatSettings;

export interface ModelTarget {
  id: ModelTargetId;
  /** Stable, server-owned label shown on approval cards and reports. */
  display_name: string;
  provider: "openai" | "together";
  model: string;
  api_key_env: "OPENAI_API_KEY" | "TOGETHER_API_KEY";
  base_url: string;
  input_usd_per_million_tokens: number;
  output_usd_per_million_tokens: number;
  adapter_profile: "openai-responses-v1" | "together-gpt-oss-chat-v1";
  evaluation_profile: EvaluationRunProfile;
}

export const MODEL_TARGETS: Record<ModelTargetId, ModelTarget> = {
  "openai/gpt-5.6-luna": {
    id: "openai/gpt-5.6-luna",
    display_name: "OpenAI GPT-5.6 Luna",
    provider: "openai",
    model: "gpt-5.6-luna",
    api_key_env: "OPENAI_API_KEY",
    base_url: "https://api.openai.com/v1",
    input_usd_per_million_tokens: 0.2,
    output_usd_per_million_tokens: 1.2,
    adapter_profile: "openai-responses-v1",
    evaluation_profile: OPENAI_GPT_5_6_RESPONSES_SETTINGS_V1,
  },
  "together/openai/gpt-oss-20b": {
    id: "together/openai/gpt-oss-20b",
    display_name: "Together AI GPT-OSS 20B",
    provider: "together",
    model: "openai/gpt-oss-20b",
    api_key_env: "TOGETHER_API_KEY",
    base_url: "https://api.together.xyz/v1",
    input_usd_per_million_tokens: 0.05,
    output_usd_per_million_tokens: 0.2,
    adapter_profile: "together-gpt-oss-chat-v1",
    evaluation_profile: TOGETHER_GPT_OSS_CHAT_SETTINGS_V1,
  },
  "together/openai/gpt-oss-120b": {
    id: "together/openai/gpt-oss-120b",
    display_name: "Together AI GPT-OSS 120B",
    provider: "together",
    model: "openai/gpt-oss-120b",
    api_key_env: "TOGETHER_API_KEY",
    base_url: "https://api.together.xyz/v1",
    input_usd_per_million_tokens: 0.15,
    output_usd_per_million_tokens: 0.6,
    adapter_profile: "together-gpt-oss-chat-v1",
    evaluation_profile: TOGETHER_GPT_OSS_CHAT_SETTINGS_V1,
  },
};

export function getModelTarget(value: string): ModelTarget {
  return MODEL_TARGETS[ModelTargetIdSchema.parse(value)];
}

export function calculateCost(
  target: ModelTarget,
  inputTokens: number,
  outputTokens: number,
): number {
  return (
    (inputTokens * target.input_usd_per_million_tokens +
      outputTokens * target.output_usd_per_million_tokens) /
    1_000_000
  );
}

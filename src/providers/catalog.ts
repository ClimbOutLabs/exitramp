import { z } from "zod/v4";

export const ModelTargetIdSchema = z.enum([
  "openai/gpt-5.6-luna",
  "together/openai/gpt-oss-20b",
  "together/openai/gpt-oss-120b",
]);

export type ModelTargetId = z.infer<typeof ModelTargetIdSchema>;

export interface ModelTarget {
  id: ModelTargetId;
  provider: "openai" | "together";
  model: string;
  api_key_env: "OPENAI_API_KEY" | "TOGETHER_API_KEY";
  base_url: string;
  input_usd_per_million_tokens: number;
  output_usd_per_million_tokens: number;
}

export const MODEL_TARGETS: Record<ModelTargetId, ModelTarget> = {
  "openai/gpt-5.6-luna": {
    id: "openai/gpt-5.6-luna",
    provider: "openai",
    model: "gpt-5.6-luna",
    api_key_env: "OPENAI_API_KEY",
    base_url: "https://api.openai.com/v1",
    input_usd_per_million_tokens: 0.2,
    output_usd_per_million_tokens: 1.2,
  },
  "together/openai/gpt-oss-20b": {
    id: "together/openai/gpt-oss-20b",
    provider: "together",
    model: "openai/gpt-oss-20b",
    api_key_env: "TOGETHER_API_KEY",
    base_url: "https://api.together.xyz/v1",
    input_usd_per_million_tokens: 0.05,
    output_usd_per_million_tokens: 0.2,
  },
  "together/openai/gpt-oss-120b": {
    id: "together/openai/gpt-oss-120b",
    provider: "together",
    model: "openai/gpt-oss-120b",
    api_key_env: "TOGETHER_API_KEY",
    base_url: "https://api.together.xyz/v1",
    input_usd_per_million_tokens: 0.15,
    output_usd_per_million_tokens: 0.6,
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

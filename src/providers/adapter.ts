import { performance } from "node:perf_hooks";

import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { ResponseFunctionToolCall } from "openai/resources/responses/responses";

import type { EvalCase, Observation, ToolCall, ToolResult } from "../domain/schemas.js";
import { calculateCost, getModelTarget, type ModelTargetId } from "./catalog.js";
import {
  executeOrderDeskTool,
  ORDERDESK_FUNCTIONS,
  ORDERDESK_INSTRUCTIONS,
  SUPPORT_DECISION_JSON_SCHEMA,
} from "./orderdesk-contract.js";

const MAX_TOOL_ROUNDS = 3;

export class MissingProviderCredentialError extends Error {
  constructor(environmentVariable: string) {
    super(`Missing required provider credential: ${environmentVariable}`);
    this.name = "MissingProviderCredentialError";
  }
}

export interface OrderDeskInvoker {
  invokeCase(targetId: ModelTargetId, testCase: EvalCase): Promise<Observation>;
}

export interface AdapterOptions {
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  timeout_ms?: number;
}

function parseArguments(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { _invalid_arguments: value };
  } catch {
    return { _invalid_arguments: value };
  }
}

function parseDecision(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export class LiveOrderDeskAdapter implements OrderDeskInvoker {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: AdapterOptions = {}) {
    this.environment = options.environment ?? process.env;
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeout_ms ?? 45_000;
  }

  async invokeCase(targetId: ModelTargetId, testCase: EvalCase): Promise<Observation> {
    const target = getModelTarget(targetId);
    const apiKey = this.environment[target.api_key_env];
    if (!apiKey) throw new MissingProviderCredentialError(target.api_key_env);

    const client = new OpenAI({
      apiKey,
      baseURL: target.base_url,
      fetch: this.fetcher,
      timeout: this.timeoutMs,
      maxRetries: 2,
    });
    return target.provider === "openai"
      ? this.invokeResponses(client, targetId, testCase)
      : this.invokeChatCompletions(client, targetId, testCase);
  }

  private async invokeResponses(
    client: OpenAI,
    targetId: ModelTargetId,
    testCase: EvalCase,
  ): Promise<Observation> {
    const target = getModelTarget(targetId);
    const startedAt = performance.now();
    const toolCalls: ToolCall[] = [];
    const toolResults: ToolResult[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let response = await client.responses.create({
      model: target.model,
      instructions: ORDERDESK_INSTRUCTIONS,
      input: testCase.prompt,
      tools: ORDERDESK_FUNCTIONS.map((tool) => ({
        type: "function" as const,
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: true,
      })),
      parallel_tool_calls: false,
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: "support_decision",
          schema: SUPPORT_DECISION_JSON_SCHEMA,
          strict: true,
        },
      },
    });

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      inputTokens += response.usage?.input_tokens ?? 0;
      outputTokens += response.usage?.output_tokens ?? 0;
      const calls = response.output.filter(
        (item): item is ResponseFunctionToolCall => item.type === "function_call",
      );
      if (calls.length === 0) break;

      const outputs = calls.map((call) => {
        const observed = { name: call.name, arguments: parseArguments(call.arguments) };
        const result = executeOrderDeskTool(observed);
        toolCalls.push(observed);
        toolResults.push({
          name: observed.name as ToolResult["name"],
          arguments: observed.arguments,
          result,
        });
        return {
          type: "function_call_output" as const,
          call_id: call.call_id,
          output: JSON.stringify(result),
        };
      });
      const priorItems = response.output.filter(
        (item) =>
          item.type === "message" || item.type === "reasoning" || item.type === "function_call",
      );
      response = await client.responses.create({
        model: target.model,
        instructions: ORDERDESK_INSTRUCTIONS,
        input: [...priorItems, ...outputs],
        tools: ORDERDESK_FUNCTIONS.map((tool) => ({
          type: "function" as const,
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          strict: true,
        })),
        parallel_tool_calls: false,
        store: false,
        text: {
          format: {
            type: "json_schema",
            name: "support_decision",
            schema: SUPPORT_DECISION_JSON_SCHEMA,
            strict: true,
          },
        },
      });
    }

    return {
      case_id: testCase.id,
      decision: parseDecision(response.output_text),
      tool_calls: toolCalls,
      tool_results: toolResults,
      latency_ms: performance.now() - startedAt,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: calculateCost(target, inputTokens, outputTokens),
    };
  }

  private async invokeChatCompletions(
    client: OpenAI,
    targetId: ModelTargetId,
    testCase: EvalCase,
  ): Promise<Observation> {
    const target = getModelTarget(targetId);
    const startedAt = performance.now();
    const toolCalls: ToolCall[] = [];
    const toolResults: ToolResult[] = [];
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: ORDERDESK_INSTRUCTIONS },
      { role: "user", content: testCase.prompt },
    ];
    const tools: ChatCompletionTool[] = ORDERDESK_FUNCTIONS.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: true,
      },
    }));
    let inputTokens = 0;
    let outputTokens = 0;
    let finalContent: string | null = null;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const completion = await client.chat.completions.create({
        model: target.model,
        messages,
        tools,
        tool_choice: "auto",
        parallel_tool_calls: false,
        temperature: 0,
        max_tokens: 1_000,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "support_decision",
            schema: SUPPORT_DECISION_JSON_SCHEMA,
            strict: true,
          },
        },
      });
      inputTokens += completion.usage?.prompt_tokens ?? 0;
      outputTokens += completion.usage?.completion_tokens ?? 0;
      const message = completion.choices[0]?.message;
      if (!message) throw new Error("Provider returned no completion choice");

      const calls = message.tool_calls?.filter((call) => call.type === "function") ?? [];
      if (calls.length === 0) {
        finalContent = message.content;
        break;
      }

      messages.push(message);
      for (const call of calls) {
        const observed = {
          name: call.function.name,
          arguments: parseArguments(call.function.arguments),
        };
        const result = executeOrderDeskTool(observed);
        toolCalls.push(observed);
        toolResults.push({
          name: observed.name as ToolResult["name"],
          arguments: observed.arguments,
          result,
        });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
    }

    return {
      case_id: testCase.id,
      decision: parseDecision(finalContent),
      tool_calls: toolCalls,
      tool_results: toolResults,
      latency_ms: performance.now() - startedAt,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: calculateCost(target, inputTokens, outputTokens),
    };
  }
}

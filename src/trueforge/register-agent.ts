import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

export const REQUIRED_EXITRAMP_TOOLS = [
  "repo_snapshot",
  "inspect_orderdesk_behavior",
  "compile_orderdesk_scenario_plan",
  "record_sandbox_verification",
  "prepare_migration_evaluation_approval",
  "run_migration_evaluation",
] as const;

const EXITRAMP_MCP_NAME = "exitramp";
const EXITRAMP_MCP_URL = "http://127.0.0.1:8788/mcp";
export const EXITRAMP_MCP_MANIFEST = {
  type: "remote" as const,
  name: EXITRAMP_MCP_NAME,
  url: EXITRAMP_MCP_URL,
  description: "ExitRamp model migration evaluation tools.",
};
const PAID_TOOL = "run_migration_evaluation";
export const MANAGED_AGENT_MARKER = "ExitRamp managed agent manifest: exitramp-orderdesk/v1.";
export const VERDICT_ONLY_RESPONSE_POLICY = [
  "Result presentation:",
  "- After an allowed run completes, return only the human-readable verdict from ExitRamp.",
  "- Do not add first-person narration or recap approval, checks, execution, or tool chronology.",
  "- In the plain-language verdict beneath the card, use these scan markers once: ✅ baseline; ❌ failed candidate or ✅ accepted candidate; 🛠️ critical-tool behavior; 🔗 typed grounding; 🚫 prohibited tool calls; 💵 estimated cost; ⚠️ rejection reasons; 🛑 final migration decision.",
  "- Keep the result card itself emoji-free.",
].join("\n");
export const EXITRAMP_PROVIDER_CREDENTIAL_BINDINGS = [
  { provider_name: "openai", header_name: "x-exitramp-openai-key" },
  { provider_name: "together", header_name: "x-exitramp-together-key" },
] as const;

const ProviderCredentialBindingSchema = z.object({
  provider_name: z.string().min(1),
  header_name: z.string().min(1),
}).strict();

const McpServerManifestSchema = z.object({
  type: z.literal("remote"),
  name: z.string().min(1),
  url: z.url(),
  description: z.string().min(1),
  provider_credentials: z.array(ProviderCredentialBindingSchema).optional(),
}).passthrough();

const ConfiguredMcpServerSchema = z.object({
  name: z.string().min(1),
  manifest: McpServerManifestSchema,
}).passthrough();

const McpServerResponseSchema = z.object({ data: ConfiguredMcpServerSchema });
type ConfiguredMcpServer = z.infer<typeof ConfiguredMcpServerSchema>;

const AgentManifestSchema = z.object({
  model: z.object({
    name: z.string().min(1),
    params: z.record(z.string(), z.unknown()).optional(),
  }).passthrough(),
  instructions: z.string().min(1),
  mcp_servers: z.array(z.object({
    name: z.string().min(1),
    enable_tools: z.array(z.string()),
    require_approval_for_tools: z.array(z.string()),
    preload: z.boolean(),
  }).passthrough()).length(1),
  config: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const ManagedExecutionConfigSchema = z.object({
  sandbox: z.object({
    enabled: z.literal(true),
  }).passthrough(),
  ask_user_questions: z.object({
    enabled: z.literal(false),
  }).passthrough(),
}).passthrough();

const ToolsResponseSchema = z.object({
  data: z.array(z.object({ name: z.string() }).passthrough()),
});

const AgentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  manifest: AgentManifestSchema,
}).passthrough();

const AgentsResponseSchema = z.object({ data: z.array(AgentSchema) });
const AgentResponseSchema = z.object({ data: AgentSchema });
type Agent = z.infer<typeof AgentSchema>;

export type AgentManifest = z.infer<typeof AgentManifestSchema>;
export type JsonFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface RegisterExitRampAgentOptions {
  trueforgeUrl?: string;
  agentName?: string;
  modelName?: string;
  manifestPath?: string;
  fetchImpl?: JsonFetch;
}

export interface RegisteredAgentResult {
  action: "created" | "updated";
  id: string;
  name: string;
}

class TrueForgeRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "TrueForgeRequestError";
  }
}

function defaultManifestPath(): string {
  return resolve(process.cwd(), "agents/exitramp.agent.json");
}

function assertExactToolPolicy(manifest: AgentManifest): void {
  const binding = manifest.mcp_servers[0];
  if (binding === undefined || binding.name !== EXITRAMP_MCP_NAME) {
    throw new Error(`Agent manifest must bind only the ${EXITRAMP_MCP_NAME} MCP server.`);
  }

  const enabled = new Set(binding.enable_tools);
  const expected = new Set<string>(REQUIRED_EXITRAMP_TOOLS);
  const missing = REQUIRED_EXITRAMP_TOOLS.filter((name) => !enabled.has(name));
  const unexpected = binding.enable_tools.filter((name) => !expected.has(name));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `ExitRamp agent tool scope is invalid (missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}).`,
    );
  }
  if (
    binding.require_approval_for_tools.length !== 1
    || binding.require_approval_for_tools[0] !== PAID_TOOL
  ) {
    throw new Error(`Only ${PAID_TOOL} may be configured as approval-gated.`);
  }
  if (!binding.preload) {
    throw new Error("ExitRamp tools must be preloaded for the TrueForge agent.");
  }
}

export async function loadAgentManifest(
  manifestPath = defaultManifestPath(),
  modelName?: string,
): Promise<AgentManifest> {
  const parsed = AgentManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  const managedInstructions = parsed.instructions.endsWith(VERDICT_ONLY_RESPONSE_POLICY)
    ? parsed.instructions
    : `${parsed.instructions}\n\n${VERDICT_ONLY_RESPONSE_POLICY}`;
  const manifest: AgentManifest = {
    ...parsed,
    instructions: managedInstructions,
    ...(modelName === undefined ? {} : { model: { ...parsed.model, name: modelName } }),
  };
  assertExactToolPolicy(manifest);
  if (!ManagedExecutionConfigSchema.safeParse(manifest.config).success) {
    throw new Error(
      "ExitRamp agent must enable the sandbox and disable alternate user-question pauses.",
    );
  }
  if (!manifest.instructions.startsWith(MANAGED_AGENT_MARKER)) {
    throw new Error("ExitRamp agent manifest is missing its managed-agent marker.");
  }
  return manifest;
}

async function requestJson(
  fetchImpl: JsonFetch,
  url: URL,
  init?: RequestInit,
): Promise<unknown> {
  const headers = new Headers(init?.headers);
  headers.set("accept", "application/json");
  if (init?.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  const response = await fetchImpl(url, {
    ...init,
    headers,
  });
  const text = await response.text();
  if (!response.ok) {
    const detail = text.trim().slice(0, 500) || response.statusText;
    throw new TrueForgeRequestError(
      response.status,
      `${init?.method ?? "GET"} ${url.pathname} failed (${response.status}): ${detail}`,
    );
  }
  return text.length === 0 ? {} : JSON.parse(text);
}

function assertManagedAgent(agent: Agent): void {
  if (!agent.manifest.instructions.startsWith(MANAGED_AGENT_MARKER)) {
    throw new Error(
      `TrueForge agent \"${agent.name}\" already exists but is not managed by ExitRamp; refusing to overwrite it.`,
    );
  }
}

async function listAgents(fetchImpl: JsonFetch, baseUrl: URL): Promise<Agent[]> {
  const payload = await requestJson(fetchImpl, new URL("/api/v1/agents", baseUrl));
  return AgentsResponseSchema.parse(payload).data;
}

function assertExitRampConnector(connector: ConfiguredMcpServer): void {
  const connectorUrl = new URL(connector.manifest.url);
  if (
    connector.name !== EXITRAMP_MCP_NAME
    || connector.manifest.name !== EXITRAMP_MCP_NAME
    || connectorUrl.href !== EXITRAMP_MCP_URL
  ) {
    throw new Error(
      `Expected the ${EXITRAMP_MCP_NAME} connector at ${EXITRAMP_MCP_URL}; refusing to bind provider credentials to a different connector.`,
    );
  }
}

function assertExactProviderCredentialBindings(connector: ConfiguredMcpServer): void {
  const bindings = connector.manifest.provider_credentials;
  if (
    bindings?.length !== EXITRAMP_PROVIDER_CREDENTIAL_BINDINGS.length
    || !EXITRAMP_PROVIDER_CREDENTIAL_BINDINGS.every((expected, index) => {
      const actual = bindings[index];
      return actual?.provider_name === expected.provider_name
        && actual.header_name === expected.header_name;
    })
  ) {
    throw new Error("TrueForge did not retain the required ExitRamp provider credential bindings.");
  }
}

async function bindProviderCredentials(
  fetchImpl: JsonFetch,
  baseUrl: URL,
): Promise<void> {
  const connectorUrl = new URL(
    `/api/v1/settings/mcp-servers/${EXITRAMP_MCP_NAME}`,
    baseUrl,
  );
  let currentPayload: unknown;
  try {
    currentPayload = await requestJson(fetchImpl, connectorUrl);
  } catch (error) {
    if (!(error instanceof TrueForgeRequestError) || error.status !== 404) throw error;
    currentPayload = await requestJson(
      fetchImpl,
      new URL("/api/v1/settings/mcp-servers", baseUrl),
      {
        method: "PUT",
        body: JSON.stringify({ manifest: EXITRAMP_MCP_MANIFEST }),
      },
    );
  }
  const current = McpServerResponseSchema.parse(currentPayload).data;
  assertExitRampConnector(current);

  const manifest = {
    ...current.manifest,
    provider_credentials: EXITRAMP_PROVIDER_CREDENTIAL_BINDINGS.map((binding) => ({
      ...binding,
    })),
  };
  const updatedPayload = await requestJson(
    fetchImpl,
    new URL("/api/v1/settings/mcp-servers", baseUrl),
    {
      method: "PUT",
      body: JSON.stringify({ manifest }),
    },
  );
  const updated = McpServerResponseSchema.parse(updatedPayload).data;
  assertExitRampConnector(updated);
  assertExactProviderCredentialBindings(updated);
}

async function updateAgent(
  fetchImpl: JsonFetch,
  baseUrl: URL,
  existing: Agent,
  manifest: AgentManifest,
): Promise<RegisteredAgentResult> {
  assertManagedAgent(existing);
  const payload = await requestJson(
    fetchImpl,
    new URL(`/api/v1/agents/${encodeURIComponent(existing.id)}`, baseUrl),
    { method: "PUT", body: JSON.stringify({ manifest }) },
  );
  const updated = AgentResponseSchema.parse(payload).data;
  return { action: "updated", id: updated.id, name: updated.name };
}

export async function registerExitRampAgent(
  options: RegisterExitRampAgentOptions = {},
): Promise<RegisteredAgentResult> {
  const baseUrl = new URL(options.trueforgeUrl ?? "http://127.0.0.1:8790");
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new Error("TRUEFORGE_URL must use http or https.");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const agentName = options.agentName ?? "exitramp-orderdesk";
  const manifest = await loadAgentManifest(options.manifestPath, options.modelName);

  await bindProviderCredentials(fetchImpl, baseUrl);

  const toolsPayload = await requestJson(
    fetchImpl,
    new URL(`/api/v1/settings/mcp-servers/${EXITRAMP_MCP_NAME}/tools`, baseUrl),
  );
  const discovered = new Set(ToolsResponseSchema.parse(toolsPayload).data.map(({ name }) => name));
  const missingTools = REQUIRED_EXITRAMP_TOOLS.filter((name) => !discovered.has(name));
  if (missingTools.length > 0) {
    throw new Error(
      `TrueForge's ${EXITRAMP_MCP_NAME} connector is missing required tools: ${missingTools.join(", ")}.`,
    );
  }

  const existing = (await listAgents(fetchImpl, baseUrl)).find(({ name }) => name === agentName);

  if (existing !== undefined) {
    return updateAgent(fetchImpl, baseUrl, existing, manifest);
  }

  try {
    const createdPayload = await requestJson(fetchImpl, new URL("/api/v1/agents", baseUrl), {
      method: "POST",
      body: JSON.stringify({ name: agentName, manifest }),
    });
    const created = AgentResponseSchema.parse(createdPayload).data;
    return { action: "created", id: created.id, name: created.name };
  } catch (error) {
    if (!(error instanceof TrueForgeRequestError) || error.status !== 409) throw error;
  }

  const racedAgent = (await listAgents(fetchImpl, baseUrl)).find(({ name }) => name === agentName);
  if (racedAgent === undefined) {
    throw new Error(`TrueForge reported an agent-name conflict for \"${agentName}\", but the agent is not visible.`);
  }
  return updateAgent(fetchImpl, baseUrl, racedAgent, manifest);
}

async function main(): Promise<void> {
  const result = await registerExitRampAgent({
    ...(process.env.TRUEFORGE_URL === undefined
      ? {}
      : { trueforgeUrl: process.env.TRUEFORGE_URL }),
    ...(process.env.EXITRAMP_TRUEFORGE_AGENT_NAME === undefined
      ? {}
      : { agentName: process.env.EXITRAMP_TRUEFORGE_AGENT_NAME }),
    ...(process.env.EXITRAMP_TRUEFORGE_AGENT_MODEL === undefined
      ? {}
      : { modelName: process.env.EXITRAMP_TRUEFORGE_AGENT_MODEL }),
  });
  process.stdout.write(`ExitRamp agent ${result.action}: ${result.name}\n`);
  process.stdout.write(`Start a new TrueForge session with agent \"${result.name}\". Existing sessions keep their original agent configuration.\n`);
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  await main();
}
